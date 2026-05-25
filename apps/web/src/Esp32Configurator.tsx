import { useEffect, useMemo, useRef, useState } from "react";
import {
  Cable,
  CheckCircle2,
  Cpu,
  KeyRound,
  PlugZap,
  RotateCw,
  Send,
  ShieldCheck,
  Usb,
  Wifi,
  XCircle
} from "lucide-react";
import type { ApiError, SafeWolGateway } from "@radio-bot/shared";
import { API_URL, createWolGateway, getState, rotateWolGatewayToken } from "./api.js";

type SerialMessage = Record<string, unknown>;

type SerialWaiter = {
  expectedType: string;
  resolve: (message: SerialMessage) => void;
  reject: (error: Error) => void;
  timer: number;
};

class SerialJsonClient {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buffer = "";
  private closed = false;
  private readonly waiters: SerialWaiter[] = [];
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor(private readonly onMessage: (message: SerialMessage) => void) {}

  async open(port: SerialPort): Promise<void> {
    this.port = port;
    await port.open({
      baudRate: 115200
    });
    await port
      .setSignals?.({
        dataTerminalReady: false,
        requestToSend: false
      })
      .catch(() => undefined);

    if (!port.readable || !port.writable) {
      throw new Error("Porta serial sem fluxo de leitura ou escrita.");
    }

    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    void this.readLoop();
  }

  async send(message: SerialMessage, expectedType: string, timeoutMs = 6000): Promise<SerialMessage> {
    if (!this.writer) {
      throw new Error("ESP32 nao conectado via USB.");
    }

    const pending = new Promise<SerialMessage>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.removeWaiter(expectedType, resolve);
        reject(new Error(`Timeout aguardando ${expectedType}.`));
      }, timeoutMs);
      this.waiters.push({
        expectedType,
        resolve,
        reject,
        timer
      });
    });

    try {
      await this.writer.write(this.encoder.encode(`${JSON.stringify(message)}\n`));
    } catch (error) {
      this.rejectWaiters(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    return pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectWaiters(new Error("Porta serial fechada."));
    await this.reader?.cancel().catch(() => undefined);
    this.writer?.releaseLock();
    this.writer = null;
    await this.port?.close().catch(() => undefined);
    this.port = null;
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed && this.reader) {
        const result = await this.reader.read();
        if (result.done) {
          break;
        }
        if (result.value) {
          this.buffer += this.decoder.decode(result.value, {
            stream: true
          });
          this.consumeBuffer();
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.onMessage({
          type: "serial_error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
    }
  }

  private consumeBuffer(): void {
    let lineBreakIndex = this.buffer.indexOf("\n");
    while (lineBreakIndex >= 0) {
      const line = this.buffer.slice(0, lineBreakIndex).trim();
      this.buffer = this.buffer.slice(lineBreakIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      lineBreakIndex = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: SerialMessage;
    try {
      message = JSON.parse(line) as SerialMessage;
    } catch {
      this.onMessage({
        type: "serial_parse_error",
        raw: line
      });
      return;
    }

    this.onMessage(message);
    const type = typeof message.type === "string" ? message.type : "";
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.expectedType === type);
    if (waiterIndex < 0) {
      return;
    }

    const waiter = this.waiters.splice(waiterIndex, 1)[0];
    window.clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  private removeWaiter(expectedType: string, resolve: (message: SerialMessage) => void): void {
    const waiterIndex = this.waiters.findIndex(
      (waiter) => waiter.expectedType === expectedType && waiter.resolve === resolve
    );
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      window.clearTimeout(waiter.timer);
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

type GatewayCredentials = {
  gatewayId: string;
  token: string;
  mode: "created" | "rotated";
};

type Esp32Status = {
  configured: boolean;
  wifiConnected: boolean;
  ip: string;
  lastError: string | null;
  apiBaseUrl: string;
  gatewayId: string;
  gatewayTokenSet: boolean;
};

const SERIAL_PROTOCOL_VERSION = 1;
const steps = ["Gateway", "USB", "Wi-Fi", "Gravar", "Validar"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function messageOk(message: SerialMessage): boolean {
  return message.ok === true;
}

function apiErrorMessage(error: unknown, fallback: string): string {
  return (error as ApiError)?.message ?? (error instanceof Error ? error.message : fallback);
}

export function Esp32Configurator({
  sessionToken,
  gateways,
  onNotice,
  onRefresh
}: {
  sessionToken: string;
  gateways: SafeWolGateway[];
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [gatewayMode, setGatewayMode] = useState<"new" | "existing">("new");
  const [newGatewayName, setNewGatewayName] = useState("ESP32 WOL");
  const [existingGatewayId, setExistingGatewayId] = useState(gateways[0]?.id ?? "");
  const [credentials, setCredentials] = useState<GatewayCredentials | null>(null);
  const [tokenMasked, setTokenMasked] = useState(false);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(normalizeUrl(API_URL));
  const [serialSupported] = useState(() => Boolean(navigator.serial) && window.isSecureContext);
  const [serialConnected, setSerialConnected] = useState(false);
  const [hello, setHello] = useState<SerialMessage | null>(null);
  const [status, setStatus] = useState<Esp32Status | null>(null);
  const [activeStep, setActiveStep] = useState<(typeof steps)[number]>("Gateway");
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const clientRef = useRef<SerialJsonClient | null>(null);

  const selectedGateway = useMemo(
    () => gateways.find((gateway) => gateway.id === existingGatewayId) ?? null,
    [existingGatewayId, gateways]
  );

  useEffect(() => {
    if (!existingGatewayId && gateways[0]) {
      setExistingGatewayId(gateways[0].id);
    }
  }, [existingGatewayId, gateways]);

  useEffect(() => {
    return () => {
      void clientRef.current?.close();
    };
  }, []);

  function pushMessage(message: string) {
    setMessages((current) => [message, ...current].slice(0, 6));
  }

  async function ensureGatewayCredentials(): Promise<GatewayCredentials> {
    if (credentials) {
      return credentials;
    }

    if (gatewayMode === "new") {
      const gateway = await createWolGateway({
        token: sessionToken,
        name: newGatewayName,
        location: "Rede local"
      });
      const next = {
        gatewayId: gateway.id,
        token: gateway.token,
        mode: "created" as const
      };
      setCredentials(next);
      setTokenMasked(false);
      await onRefresh();
      pushMessage("Gateway criado e token mantido temporariamente no wizard.");
      return next;
    }

    if (!selectedGateway) {
      throw new Error("Selecione um gateway existente.");
    }

    const confirmed = window.confirm(
      `Rotacionar o token do gateway "${selectedGateway.name}"? O token antigo deixa de funcionar ate reconfigurar o ESP32.`
    );
    if (!confirmed) {
      throw new Error("Rotacao de token cancelada.");
    }

    const gateway = await rotateWolGatewayToken({
      token: sessionToken,
      gatewayId: selectedGateway.id
    });
    const next = {
      gatewayId: gateway.id,
      token: gateway.token,
      mode: "rotated" as const
    };
    setCredentials(next);
    setTokenMasked(false);
    await onRefresh();
    pushMessage("Token rotacionado e mantido temporariamente no wizard.");
    return next;
  }

  async function prepareGateway() {
    setBusy("gateway");
    try {
      await ensureGatewayCredentials();
      setActiveStep("USB");
      onNotice("Gateway preparado para configuracao USB.", "success");
    } catch (error) {
      onNotice(apiErrorMessage(error, "Nao foi possivel preparar o gateway."));
    } finally {
      setBusy(null);
    }
  }

  async function connectSerial() {
    if (!window.isSecureContext) {
      onNotice("Web Serial exige HTTPS em producao.");
      return;
    }
    if (!navigator.serial) {
      onNotice("Este navegador nao suporta Web Serial.");
      return;
    }

    setBusy("serial");
    try {
      const port = await navigator.serial.requestPort();
      const client = new SerialJsonClient((message) => {
        const type = typeof message.type === "string" ? message.type : "serial";
        pushMessage(type);
      });
      await client.open(port);
      clientRef.current = client;
      setSerialConnected(true);
      setActiveStep("USB");
      pushMessage("Porta serial aberta; aguardando reset automatico do ESP32.");
      await sleep(2500);
      await sendHelloWithRetries();
      onNotice("ESP32 conectado via USB.", "success");
    } catch (error) {
      await clientRef.current?.close();
      clientRef.current = null;
      setSerialConnected(false);
      onNotice(apiErrorMessage(error, "Nao foi possivel conectar ao ESP32."));
    } finally {
      setBusy(null);
    }
  }

  async function disconnectSerial() {
    setBusy("disconnect");
    try {
      await clientRef.current?.close();
      clientRef.current = null;
      setSerialConnected(false);
      setHello(null);
      onNotice("Porta serial desconectada.", "success");
    } finally {
      setBusy(null);
    }
  }

  async function sendHelloWithRetries(): Promise<SerialMessage> {
    const client = clientRef.current;
    if (!client) {
      throw new Error("Conecte o ESP32 via USB.");
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await client.send({ type: "hello" }, "hello_result", 2500);
        if (!messageOk(response)) {
          throw new Error(String(response.message ?? "ESP32 recusou hello."));
        }
        if (response.protocolVersion !== SERIAL_PROTOCOL_VERSION) {
          throw new Error("Versao de protocolo serial incompativel.");
        }
        setHello(response);
        setActiveStep("Wi-Fi");
        return response;
      } catch (error) {
        lastError = error;
        await sleep(700);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("ESP32 nao respondeu hello.");
  }

  async function validateApiBaseUrl(): Promise<string> {
    const nextApiUrl = normalizeUrl(apiBaseUrl);
    const parsed = new URL(nextApiUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("URL da API precisa usar http ou https.");
    }

    const response = await fetch(`${nextApiUrl}/health`);
    const data = (await response.json()) as { service?: string };
    if (!response.ok || data.service !== "radio-bot-api") {
      throw new Error("A URL informada nao respondeu como API do Radio BOT.");
    }

    setApiBaseUrl(nextApiUrl);
    return nextApiUrl;
  }

  async function readStatusWithRetries(): Promise<Esp32Status> {
    const client = clientRef.current;
    if (!client) {
      throw new Error("Conecte o ESP32 via USB.");
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const response = await client.send({ type: "status" }, "status_result", 3000);
        if (!messageOk(response)) {
          throw new Error(String(response.message ?? "ESP32 recusou status."));
        }
        const nextStatus: Esp32Status = {
          configured: response.configured === true,
          wifiConnected: response.wifiConnected === true,
          ip: typeof response.ip === "string" ? response.ip : "",
          lastError: typeof response.lastError === "string" ? response.lastError : null,
          apiBaseUrl: typeof response.apiBaseUrl === "string" ? response.apiBaseUrl : "",
          gatewayId: typeof response.gatewayId === "string" ? response.gatewayId : "",
          gatewayTokenSet: response.gatewayTokenSet === true
        };
        setStatus(nextStatus);
        return nextStatus;
      } catch (error) {
        lastError = error;
        await sleep(1200);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("ESP32 nao retornou status.");
  }

  async function waitGatewayOnline(gatewayId: string): Promise<void> {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const state = await getState(sessionToken);
      const gateway = state.wolGateways.find((item) => item.id === gatewayId);
      if (gateway?.status === "online") {
        await onRefresh();
        return;
      }
      await sleep(2500);
    }

    throw new Error("Gateway nao apareceu online dentro do timeout.");
  }

  async function configureEsp32() {
    setBusy("configure");
    try {
      const gatewayCredentials = await ensureGatewayCredentials();
      const client = clientRef.current;
      if (!client) {
        throw new Error("Conecte o ESP32 via USB antes de gravar.");
      }
      if (!wifiSsid.trim()) {
        throw new Error("Informe o SSID do Wi-Fi.");
      }

      setActiveStep("Gravar");
      const validatedApiUrl = await validateApiBaseUrl();
      const response = await client.send(
        {
          type: "configure",
          wifiSsid: wifiSsid.trim(),
          wifiPassword,
          apiBaseUrl: validatedApiUrl,
          gatewayId: gatewayCredentials.gatewayId,
          gatewayToken: gatewayCredentials.token
        },
        "configure_result",
        7000
      );
      if (!messageOk(response) || response.saved !== true) {
        throw new Error(String(response.message ?? "ESP32 nao salvou a configuracao."));
      }

      setTokenMasked(true);
      setActiveStep("Validar");
      pushMessage("Configuracao salva; aguardando reboot do ESP32.");
      await sleep(4500);
      const nextStatus = await readStatusWithRetries();
      if (!nextStatus.wifiConnected) {
        throw new Error(nextStatus.lastError ?? "ESP32 ainda nao conectou ao Wi-Fi.");
      }

      await waitGatewayOnline(gatewayCredentials.gatewayId);
      onNotice("ESP32 configurado e online.", "success");
    } catch (error) {
      onNotice(apiErrorMessage(error, "Nao foi possivel configurar o ESP32."));
    } finally {
      setBusy(null);
    }
  }

  async function testStatus() {
    setBusy("status");
    try {
      await readStatusWithRetries();
      onNotice("Status do ESP32 atualizado.", "success");
    } catch (error) {
      onNotice(apiErrorMessage(error, "Nao foi possivel consultar status."));
    } finally {
      setBusy(null);
    }
  }

  async function resetConfig() {
    const confirmed = window.confirm("Limpar a configuracao salva neste ESP32?");
    if (!confirmed) {
      return;
    }

    setBusy("reset");
    try {
      const client = clientRef.current;
      if (!client) {
        throw new Error("Conecte o ESP32 via USB.");
      }
      const response = await client.send({ type: "reset_config" }, "reset_config_result", 5000);
      if (!messageOk(response) || response.cleared !== true) {
        throw new Error(String(response.message ?? "ESP32 nao limpou a configuracao."));
      }
      setStatus(null);
      onNotice("Configuracao do ESP32 limpa.", "success");
    } catch (error) {
      onNotice(apiErrorMessage(error, "Nao foi possivel limpar a configuracao."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="esp-configurator" aria-label="Configurar ESP32 via USB">
      <header className="esp-configurator-head">
        <div>
          <span>USB</span>
          <h4>Configurar ESP32 via USB</h4>
        </div>
        <span className={`status-badge ${serialConnected ? "enabled" : "disabled"}`}>
          {serialConnected ? "Conectado" : "Desconectado"}
        </span>
      </header>

      <div className="esp-steps" aria-label="Etapas">
        {steps.map((step) => (
          <span key={step} className={step === activeStep ? "active" : ""}>
            {step}
          </span>
        ))}
      </div>

      <div className="esp-config-grid">
        <div className="config-block">
          <strong>Gateway</strong>
          <div className="segmented-control" role="group" aria-label="Tipo de gateway">
            <button
              type="button"
              className={gatewayMode === "new" ? "active" : ""}
              onClick={() => {
                setGatewayMode("new");
                setCredentials(null);
              }}
            >
              Novo
            </button>
            <button
              type="button"
              className={gatewayMode === "existing" ? "active" : ""}
              onClick={() => {
                setGatewayMode("existing");
                setCredentials(null);
              }}
            >
              Existente
            </button>
          </div>

          {gatewayMode === "new" ? (
            <label>
              Nome
              <input
                value={newGatewayName}
                onChange={(event) => {
                  setCredentials(null);
                  setNewGatewayName(event.target.value);
                }}
                placeholder="ESP32 Studio 01"
              />
            </label>
          ) : (
            <label>
              Gateway
              <select
                value={existingGatewayId}
                onChange={(event) => {
                  setCredentials(null);
                  setExistingGatewayId(event.target.value);
                }}
              >
                {gateways.map((gateway) => (
                  <option key={gateway.id} value={gateway.id}>
                    {gateway.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            className="small-action"
            type="button"
            disabled={busy !== null || (gatewayMode === "existing" && gateways.length === 0)}
            onClick={prepareGateway}
          >
            {gatewayMode === "existing" ? <RotateCw aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
            {busy === "gateway" ? "Preparando" : "Preparar gateway"}
          </button>

          {credentials ? (
            <div className="token-box compact-note">
              <KeyRound aria-hidden="true" />
              <div>
                <p>{credentials.mode === "created" ? "Gateway criado" : "Token rotacionado"}</p>
                <code>
                  WOL_GATEWAY_ID={credentials.gatewayId}
                  {"\n"}WOL_GATEWAY_TOKEN={tokenMasked ? "********" : credentials.token}
                </code>
              </div>
            </div>
          ) : null}
        </div>

        <div className="config-block">
          <strong>USB</strong>
          <div className="esp-usb-actions">
            <button
              className="small-action"
              type="button"
              disabled={!serialSupported || busy !== null || serialConnected}
              onClick={connectSerial}
            >
              <Usb aria-hidden="true" />
              {busy === "serial" ? "Conectando" : "Conectar ESP32"}
            </button>
            <button
              className="ghost-button"
              type="button"
              disabled={!serialConnected || busy !== null}
              onClick={disconnectSerial}
            >
              <XCircle aria-hidden="true" />
              Desconectar
            </button>
          </div>
          <div className="esp-status-line">
            {serialSupported ? <Cable aria-hidden="true" /> : <XCircle aria-hidden="true" />}
            <span>{serialSupported ? "Web Serial disponivel" : "Web Serial ou HTTPS indisponivel"}</span>
          </div>
          {hello ? (
            <div className="esp-status-line">
              <Cpu aria-hidden="true" />
              <span>
                Firmware {String(hello.firmwareVersion ?? "-")} / protocolo{" "}
                {String(hello.protocolVersion ?? "-")}
              </span>
            </div>
          ) : null}
        </div>

        <div className="config-block">
          <strong>Wi-Fi e API</strong>
          <label>
            SSID
            <input
              value={wifiSsid}
              onChange={(event) => setWifiSsid(event.target.value)}
              placeholder="Rede da radio"
            />
          </label>
          <label>
            Senha
            <input
              type="password"
              value={wifiPassword}
              onChange={(event) => setWifiPassword(event.target.value)}
              placeholder="Senha do Wi-Fi"
            />
          </label>
          <label>
            URL da API
            <input value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} />
          </label>
        </div>

        <div className="config-block">
          <strong>Gravar e validar</strong>
          <button
            className="small-action"
            type="button"
            disabled={busy !== null || !serialConnected}
            onClick={configureEsp32}
          >
            <Send aria-hidden="true" />
            {busy === "configure" ? "Gravando" : "Gravar configuracao"}
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={busy !== null || !serialConnected}
            onClick={testStatus}
          >
            <ShieldCheck aria-hidden="true" />
            Testar status
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={busy !== null || !serialConnected}
            onClick={resetConfig}
          >
            <RotateCw aria-hidden="true" />
            Limpar configuracao
          </button>
        </div>
      </div>

      <div className="esp-validation-strip">
        <span>
          <PlugZap aria-hidden="true" />
          {credentials ? `Gateway ${credentials.gatewayId}` : "Gateway pendente"}
        </span>
        <span>
          <Wifi aria-hidden="true" />
          {status ? (status.wifiConnected ? `Wi-Fi ${status.ip}` : "Wi-Fi offline") : "Wi-Fi pendente"}
        </span>
        <span>
          {status?.gatewayTokenSet ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
          {status?.gatewayTokenSet ? "Token gravado" : "Token pendente"}
        </span>
      </div>

      {status?.lastError ? <p className="esp-error">{status.lastError}</p> : null}

      {messages.length > 0 ? (
        <div className="esp-message-log" aria-label="Eventos seriais">
          {messages.map((message, index) => (
            <span key={`${message}-${index}`}>{message}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
