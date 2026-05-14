import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  CircleDot,
  Globe2,
  LogIn,
  Monitor,
  KeyRound,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Radio,
  RefreshCw,
  Save,
  ShieldAlert,
  Wifi,
  WifiOff,
  X,
  Zap
} from "lucide-react";
import type {
  ApiError,
  CommandAction,
  ConfirmationPrompt,
  DashboardState,
  ProfileConflict,
  SafeDevice,
  SafeSiteProfile,
  SafeWolGateway,
  SitePrompt
} from "@radio-bot/shared";
import {
  createDevice,
  createProfile,
  createWolGateway,
  getState,
  login,
  sendCommand,
  updateDeviceProfiles,
  updateDeviceWol
} from "./api.js";

const actionLabels: Record<CommandAction, string> = {
  open_site: "Abrir site",
  login: "Entrar",
  reload: "Recarregar",
  screenshot: "Captura de tela",
  get_state: "Estado",
  click_action: "Clicar acao",
  confirm_open_here: "Abrir nesta janela",
  power_on: "Ligar computador"
};

function actionLabel(action: CommandAction): string {
  return actionLabels[action] ?? action;
}

type CommandButton = {
  key: string;
  icon: typeof Globe2;
  label?: string;
  availableOffline?: boolean;
  resolveAction: (profile: SafeSiteProfile | null) => CommandAction;
};

const commandButtons: CommandButton[] = [
  {
    key: "power_on",
    icon: PowerOff,
    availableOffline: true,
    resolveAction: () => "power_on"
  },
  {
    key: "open",
    icon: Globe2,
    label: "Abrir",
    resolveAction: (profile) => (profile?.hasCredentials ? "login" : "open_site")
  },
  { key: "reload", icon: RefreshCw, resolveAction: () => "reload" },
  { key: "screenshot", icon: Camera, resolveAction: () => "screenshot" },
  { key: "get_state", icon: Activity, resolveAction: () => "get_state" }
];

type PendingConflict = {
  action: CommandAction;
  conflict: ProfileConflict;
  confirmation: ConfirmationPrompt;
  step: 1 | 2;
};

type PendingSitePrompt = {
  commandId: string;
  deviceId: string;
  profileId: string;
  prompt: SitePrompt;
};

type ProfileMode = "direct" | "login";

function storedToken(): string | null {
  return window.localStorage.getItem("radio-bot-token");
}

export function App() {
  const [token, setToken] = useState<string | null>(() => storedToken());
  const [email, setEmail] = useState("admin@radio.local");
  const [password, setPassword] = useState("");
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<CommandAction | null>(null);
  const [message, setMessageState] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const setMessage = (text: string | null, tone: "error" | "success" = "error") => {
    setMessageState(text === null ? null : { text, tone });
  };
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [pendingSitePrompt, setPendingSitePrompt] = useState<PendingSitePrompt | null>(null);
  const [dismissedPromptIds, setDismissedPromptIds] = useState<string[]>([]);
  const [adminOpen, setAdminOpen] = useState(false);
  const [wolOpen, setWolOpen] = useState(false);
  const [editDevicesOpen, setEditDevicesOpen] = useState(false);
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);

  const selectedDevice = useMemo(
    () => dashboard?.devices.find((device) => device.id === selectedDeviceId) ?? null,
    [dashboard, selectedDeviceId]
  );
  const selectedProfile = useMemo(
    () => dashboard?.profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [dashboard, selectedProfileId]
  );

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const state = await getState(token);
        if (cancelled) {
          return;
        }
        setDashboard(state);
        setSelectedDeviceId((current) => current ?? state.devices[0]?.id ?? null);
        setSelectedProfileId((current) => current ?? state.profiles[0]?.id ?? null);
        const promptCommand = state.commands.find((command) => {
          const sitePrompt = command.output?.sitePrompt as SitePrompt | undefined;
          return (
            command.status === "waiting_confirmation" &&
            sitePrompt?.type === "open_here" &&
            !dismissedPromptIds.includes(command.id)
          );
        });
        if (promptCommand) {
          setPendingSitePrompt({
            commandId: promptCommand.id,
            deviceId: promptCommand.deviceId,
            profileId: promptCommand.profileId,
            prompt: promptCommand.output?.sitePrompt as SitePrompt
          });
        }
      } catch (error) {
        const apiError = error as ApiError;
        if (apiError.code === "UNAUTHORIZED") {
          window.localStorage.removeItem("radio-bot-token");
          setToken(null);
        } else {
          setMessage(apiError.message ?? "Falha ao atualizar estado.");
        }
      }
    };

    refresh();
    const interval = window.setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [token, dismissedPromptIds]);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    try {
      const session = await login(email, password);
      window.localStorage.setItem("radio-bot-token", session.token);
      setToken(session.token);
    } catch (error) {
      setMessage((error as ApiError).message ?? "Nao foi possivel entrar.");
    }
  }

  async function runCommand(action: CommandAction, confirmations = 0) {
    if (!token || !selectedDeviceId || !selectedProfileId) {
      return;
    }

    setBusyAction(action);
    setMessage(null);
    try {
      await sendCommand({
        token,
        deviceId: selectedDeviceId,
        profileId: selectedProfileId,
        action,
        confirmations
      });
      setPendingConflict(null);
      setDashboard(await getState(token));
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.code === "PROFILE_ACTIVE_ELSEWHERE" && apiError.conflict) {
        setPendingConflict({
          action,
          conflict: apiError.conflict,
          confirmation: apiError.confirmation ?? {
            title: "Confirmar acao",
            message: apiError.message,
            confirmLabel: "Continuar",
            requiredConfirmations: apiError.conflict.requiredConfirmations
          },
          step: 1
        });
      } else {
        setMessage(apiError.message ?? "Comando nao executado.");
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmSitePrompt() {
    if (!token || !pendingSitePrompt) {
      return;
    }

    const dismissedId = pendingSitePrompt.commandId;
    setBusyAction("confirm_open_here");
    try {
      await sendCommand({
        token,
        deviceId: pendingSitePrompt.deviceId,
        profileId: pendingSitePrompt.profileId,
        action: "confirm_open_here"
      });
      setDismissedPromptIds((current) =>
        current.includes(dismissedId) ? current : [...current, dismissedId]
      );
      setPendingSitePrompt(null);
      setDashboard(await getState(token));
    } catch (error) {
      setMessage((error as ApiError).message ?? "Nao foi possivel continuar no site.");
    } finally {
      setBusyAction(null);
    }
  }

  function logout() {
    window.localStorage.removeItem("radio-bot-token");
    setToken(null);
    setDashboard(null);
  }

  if (!token) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-mark">
            <Radio aria-hidden="true" />
            <span>Radio BOT</span>
          </div>
          <form onSubmit={submitLogin} className="login-form">
            <label>
              Email
              <input value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <label>
              Senha
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="primary-button" type="submit">
              <LogIn aria-hidden="true" />
              Entrar
            </button>
            {message ? <p className="form-error">{message.text}</p> : null}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <Radio aria-hidden="true" />
          <span>Radio BOT</span>
        </div>
        <button className="icon-button" type="button" onClick={logout} title="Sair">
          <Power aria-hidden="true" />
        </button>
      </header>

      <section className="workspace">
        <aside className="rail">
          <SectionTitle icon={Radio} label="Radios" />
          <div className="stack">
            {dashboard?.profiles.map((profile) => (
              <ProfileButton
                key={profile.id}
                profile={profile}
                active={profile.id === selectedProfileId}
                onClick={() => setSelectedProfileId(profile.id)}
              />
            ))}
          </div>

          <SectionTitle icon={Monitor} label="Computadores" />
          <div className="stack">
            {dashboard?.devices.map((device) => (
              <DeviceButton
                key={device.id}
                device={device}
                active={device.id === selectedDeviceId}
                onClick={() => setSelectedDeviceId(device.id)}
              />
            ))}
          </div>

          <button className="admin-launch" type="button" onClick={() => setAdminOpen(true)}>
            <Plus aria-hidden="true" />
            Adicionar
          </button>
          <button className="admin-launch" type="button" onClick={() => setWolOpen(true)}>
            <Zap aria-hidden="true" />
            Configurar Wake on LAN
          </button>
          <button className="admin-launch" type="button" onClick={() => setEditDevicesOpen(true)}>
            <Pencil aria-hidden="true" />
            Editar computadores
          </button>
        </aside>

        <section className="control-surface">
          <div className="surface-head">
            <div>
              <p className="eyebrow">Controle local</p>
              <h1>{selectedDevice?.name ?? "Nenhum computador"}</h1>
            </div>
            <StatusPill device={selectedDevice} />
          </div>

          <div className="readout-grid">
            <Readout label="Radio" value={selectedProfile?.name ?? "-"} />
            <Readout label="Usuario" value={selectedProfile?.usernameLabel ?? "-"} />
            <Readout label="URL local" value={selectedDevice?.activeUrl ?? "-"} />
            <Readout label="Titulo" value={selectedDevice?.title ?? "-"} />
          </div>

          <div className="command-strip">
            {commandButtons.map((button) => {
              const Icon = button.icon;
              const action = button.resolveAction(selectedProfile);
              const label = button.label ?? actionLabel(action);
              const requiresOnline = !button.availableOffline;
              const disabled =
                busyAction !== null ||
                (requiresOnline && selectedDevice?.status !== "online");
              return (
                <button
                  key={button.key}
                  className="command-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => runCommand(action)}
                  title={label}
                >
                  <Icon aria-hidden="true" />
                  <span>{busyAction === action ? "Enviando" : label}</span>
                </button>
              );
            })}
          </div>

          {message ? (
            <div className={`inline-alert tone-${message.tone}`}>
              {message.tone === "success" ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <AlertTriangle aria-hidden="true" />
              )}
              <span>{message.text}</span>
              <button
                className="icon-button alert-close"
                type="button"
                onClick={() => setMessage(null)}
                title="Fechar"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ) : null}

          <CommandLog dashboard={dashboard} onExpandScreenshot={setExpandedScreenshot} />
        </section>
      </section>

      {pendingConflict ? (
        <ConflictModal
          conflict={pendingConflict}
          profile={selectedProfile}
          onCancel={() => setPendingConflict(null)}
          onAdvance={() =>
            setPendingConflict((current) => (current ? { ...current, step: 2 } : current))
          }
          onConfirm={() => runCommand(pendingConflict.action, 2)}
        />
      ) : null}

      {adminOpen ? (
        <AdminForms
          token={token}
          profiles={dashboard?.profiles ?? []}
          onClose={() => setAdminOpen(false)}
          onNotice={setMessage}
          onRefresh={async () => setDashboard(await getState(token))}
        />
      ) : null}

      {pendingSitePrompt ? (
        <SitePromptModal
          prompt={pendingSitePrompt.prompt}
          onCancel={() => {
            const dismissedId = pendingSitePrompt.commandId;
            setDismissedPromptIds((current) =>
              current.includes(dismissedId) ? current : [...current, dismissedId]
            );
            setPendingSitePrompt(null);
          }}
          onConfirm={confirmSitePrompt}
        />
      ) : null}

      {wolOpen ? (
        <WolModal
          token={token}
          devices={dashboard?.devices ?? []}
          gateways={dashboard?.wolGateways ?? []}
          onClose={() => setWolOpen(false)}
          onNotice={setMessage}
          onRefresh={async () => setDashboard(await getState(token))}
        />
      ) : null}

      {editDevicesOpen ? (
        <DeviceProfilesModal
          token={token}
          devices={dashboard?.devices ?? []}
          profiles={dashboard?.profiles ?? []}
          onClose={() => setEditDevicesOpen(false)}
          onNotice={setMessage}
          onRefresh={async () => setDashboard(await getState(token))}
        />
      ) : null}

      {expandedScreenshot ? (
        <ScreenshotViewer
          src={expandedScreenshot}
          onClose={() => setExpandedScreenshot(null)}
        />
      ) : null}
    </main>
  );
}

function WolModal({
  token,
  devices,
  gateways,
  onClose,
  onNotice,
  onRefresh
}: {
  token: string;
  devices: SafeDevice[];
  gateways: SafeWolGateway[];
  onClose: () => void;
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<
    Record<string, { mac: string; broadcast: string; gatewayId: string }>
  >(() => {
    const initial: Record<string, { mac: string; broadcast: string; gatewayId: string }> = {};
    for (const device of devices) {
      initial[device.id] = {
        mac: device.macAddress ?? "",
        broadcast: device.broadcastAddress ?? "",
        gatewayId: device.wolGatewayId ?? ""
      };
    }
    return initial;
  });
  const [gatewayName, setGatewayName] = useState("");
  const [gatewayLocation, setGatewayLocation] = useState("");
  const [generatedGateway, setGeneratedGateway] = useState<{
    gatewayId: string;
    token: string;
  } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [creatingGateway, setCreatingGateway] = useState(false);

  async function submitGateway(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingGateway(true);
    try {
      const gateway = await createWolGateway({
        token,
        name: gatewayName,
        location: gatewayLocation
      });
      setGatewayName("");
      setGatewayLocation("");
      setGeneratedGateway({
        gatewayId: gateway.id,
        token: gateway.token
      });
      onNotice("Gateway ESP32 criado.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel criar o gateway.");
    } finally {
      setCreatingGateway(false);
    }
  }

  async function save(deviceId: string) {
    const draft = drafts[deviceId];
    if (!draft) {
      return;
    }
    setSavingId(deviceId);
    try {
      await updateDeviceWol({
        token,
        deviceId,
        macAddress: draft.mac,
        broadcastAddress: draft.broadcast,
        wolGatewayId: draft.gatewayId
      });
      onNotice("Configuracao salva.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel salvar.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wol-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Wake on LAN</p>
            <h2 id="wol-title">Configurar Wake on LAN</h2>
          </div>
          <button className="icon-button modal-close" type="button" onClick={onClose} title="Fechar">
            <X aria-hidden="true" />
          </button>
        </div>

        <p className="wol-hint">
          Cadastre o endereco MAC de cada computador e (opcional) o broadcast da rede em que ele
          esta. Um gateway ESP32 conectado ao mesmo servidor le essa configuracao e envia o magic
          packet quando o botao "Ligar computador" for clicado no painel.
        </p>

        <form className="mini-form wol-gateway-form" onSubmit={submitGateway}>
          <label>
            Nome do gateway
            <input
              value={gatewayName}
              onChange={(event) => setGatewayName(event.target.value)}
              placeholder="ESP32 Studio 01"
              required
            />
          </label>
          <label>
            Local
            <input
              value={gatewayLocation}
              onChange={(event) => setGatewayLocation(event.target.value)}
              placeholder="Rack da radio"
              required
            />
          </label>
          <button className="small-action" type="submit" disabled={creatingGateway}>
            <Plus aria-hidden="true" />
            {creatingGateway ? "Criando" : "Criar gateway"}
          </button>
        </form>

        {generatedGateway ? (
          <div className="inline-alert">
            <KeyRound aria-hidden="true" />
            <span>
              Configure o ESP32 com WOL_GATEWAY_ID={generatedGateway.gatewayId} e
              WOL_GATEWAY_TOKEN={generatedGateway.token}
            </span>
          </div>
        ) : null}

        <div className="wol-grid">
          {devices.length === 0 ? <p className="muted">Nenhum computador cadastrado.</p> : null}
          {devices.map((device) => {
            const draft = drafts[device.id] ?? { mac: "", broadcast: "", gatewayId: "" };
            const gateway = gateways.find((item) => item.id === draft.gatewayId) ?? null;
            return (
              <article className="wol-row" key={device.id}>
                <header>
                  <strong>{device.name}</strong>
                  <span>
                    {gateway
                      ? `${gateway.name} - ${gateway.status === "online" ? "online" : "offline"}`
                      : device.location}
                  </span>
                </header>
                <label>
                  Gateway ESP32
                  <select
                    value={draft.gatewayId}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [device.id]: { ...draft, gatewayId: event.target.value }
                      }))
                    }
                  >
                    <option value="">Sem gateway</option>
                    {gateways.map((gatewayOption) => (
                      <option key={gatewayOption.id} value={gatewayOption.id}>
                        {gatewayOption.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  MAC
                  <input
                    value={draft.mac}
                    placeholder="AA:BB:CC:DD:EE:FF"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [device.id]: { ...draft, mac: event.target.value }
                      }))
                    }
                  />
                </label>
                <label>
                  Broadcast
                  <input
                    value={draft.broadcast}
                    placeholder="192.168.1.255"
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [device.id]: { ...draft, broadcast: event.target.value }
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className="small-action"
                  disabled={savingId === device.id}
                  onClick={() => save(device.id)}
                >
                  <Save aria-hidden="true" />
                  {savingId === device.id ? "Salvando" : "Salvar"}
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function DeviceProfilesModal({
  token,
  devices,
  profiles,
  onClose,
  onNotice,
  onRefresh
}: {
  token: string;
  devices: SafeDevice[];
  profiles: SafeSiteProfile[];
  onClose: () => void;
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    for (const device of devices) {
      initial[device.id] = [...device.profileIds];
    }
    return initial;
  });
  const [savingId, setSavingId] = useState<string | null>(null);

  function toggleProfile(deviceId: string, profileId: string) {
    setDrafts((current) => {
      const selected = current[deviceId] ?? [];
      const next = selected.includes(profileId)
        ? selected.filter((id) => id !== profileId)
        : [...selected, profileId];
      return { ...current, [deviceId]: next };
    });
  }

  async function save(deviceId: string) {
    setSavingId(deviceId);
    try {
      await updateDeviceProfiles({
        token,
        deviceId,
        profileIds: drafts[deviceId] ?? []
      });
      onNotice("Radios vinculadas atualizadas.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel atualizar.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-devices-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Editar</p>
            <h2 id="edit-devices-title">Vincular radios aos computadores</h2>
          </div>
          <button className="icon-button modal-close" type="button" onClick={onClose} title="Fechar">
            <X aria-hidden="true" />
          </button>
        </div>

        <p className="wol-hint">
          Marque quais radios cada computador pode controlar. Um computador sem radio vinculada
          nao recebe comandos.
        </p>

        <div className="wol-grid">
          {devices.length === 0 ? <p className="muted">Nenhum computador cadastrado.</p> : null}
          {profiles.length === 0 ? (
            <p className="muted">Nenhuma radio cadastrada. Adicione uma radio primeiro.</p>
          ) : null}
          {devices.map((device) => {
            const selected = drafts[device.id] ?? [];
            return (
              <article className="wol-row" key={device.id}>
                <header>
                  <strong>{device.name}</strong>
                  <span>{device.location}</span>
                </header>
                <div className="profile-checkbox-list">
                  {profiles.map((profile) => (
                    <label key={profile.id} className="profile-checkbox">
                      <input
                        type="checkbox"
                        checked={selected.includes(profile.id)}
                        onChange={() => toggleProfile(device.id, profile.id)}
                      />
                      <span>{profile.name}</span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="small-action"
                  disabled={savingId === device.id || profiles.length === 0}
                  onClick={() => save(device.id)}
                >
                  <Save aria-hidden="true" />
                  {savingId === device.id ? "Salvando" : "Salvar"}
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ScreenshotViewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop screenshot-backdrop" role="presentation" onClick={onClose}>
      <button
        className="icon-button screenshot-close"
        type="button"
        onClick={onClose}
        title="Fechar"
      >
        <X aria-hidden="true" />
      </button>
      <img
        className="screenshot-full"
        src={src}
        alt="Captura de tela ampliada"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

function AdminForms({
  token,
  profiles,
  onClose,
  onNotice,
  onRefresh
}: {
  token: string;
  profiles: SafeSiteProfile[];
  onClose: () => void;
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [profileName, setProfileName] = useState("");
  const [profileMode, setProfileMode] = useState<ProfileMode>("direct");
  const [siteUrl, setSiteUrl] = useState("http://app.radios.srv.br");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [location, setLocation] = useState("");
  const [profileId, setProfileId] = useState("");
  const [generatedToken, setGeneratedToken] = useState<{
    deviceId: string;
    token: string;
  } | null>(null);

  async function submitProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await createProfile({
        token,
        name: profileName,
        siteUrl,
        username: profileMode === "login" ? username : "",
        password: profileMode === "login" ? password : ""
      });
      setProfileName("");
      setUsername("");
      setPassword("");
      onNotice("Radio adicionada.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel adicionar radio.");
    }
  }

  async function submitDevice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const selectedProfileId = profileId || profiles[0]?.id;
      const device = await createDevice({
        token,
        name: deviceName,
        location,
        profileIds: selectedProfileId ? [selectedProfileId] : []
      });
      setDeviceName("");
      setLocation("");
      setGeneratedToken({
        deviceId: device.id,
        token: device.token
      });
      onNotice("Computador adicionado.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel adicionar computador.");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title">
        <div className="modal-head">
          <div>
            <p className="eyebrow">Cadastro</p>
            <h2 id="admin-title">Adicionar</h2>
          </div>
          <button className="icon-button modal-close" type="button" onClick={onClose} title="Fechar">
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="admin-modal-grid">
          <form className="mini-form" onSubmit={submitProfile}>
            <strong>Radio</strong>
            <div className="segmented-control" role="radiogroup" aria-label="Tipo de acesso">
              <button
                type="button"
                className={profileMode === "direct" ? "active" : ""}
                onClick={() => setProfileMode("direct")}
              >
                Link direto
              </button>
              <button
                type="button"
                className={profileMode === "login" ? "active" : ""}
                onClick={() => setProfileMode("login")}
              >
                Login
              </button>
            </div>
            <input
              required
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              placeholder="Nome"
            />
            <input
              required
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
              placeholder="URL"
            />
            {profileMode === "login" ? (
              <>
                <input
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Usuario"
                />
                <input
                  required
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Senha"
                />
              </>
            ) : null}
            <button className="small-action" type="submit">
              <Plus aria-hidden="true" />
              Radio
            </button>
          </form>

          <form className="mini-form" onSubmit={submitDevice}>
            <strong>Computador</strong>
            <input
              required
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="Nome"
            />
            <input
              required
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Local"
            />
            <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <button className="small-action" type="submit">
              <Plus aria-hidden="true" />
              Computador
            </button>
          </form>
        </div>

        {generatedToken ? (
          <div className="token-box">
            <KeyRound aria-hidden="true" />
            <code>
              DEVICE_ID={generatedToken.deviceId}
              {"\n"}DEVICE_TOKEN={generatedToken.token}
            </code>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SectionTitle({ icon: Icon, label }: { icon: typeof Radio; label: string }) {
  return (
    <div className="section-title">
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function ProfileButton({
  profile,
  active,
  onClick
}: {
  profile: SafeSiteProfile;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`select-row ${active ? "active" : ""}`} type="button" onClick={onClick}>
      <span className="row-main">{profile.name}</span>
      <span className="row-sub">{profile.usernameLabel}</span>
    </button>
  );
}

function DeviceButton({
  device,
  active,
  onClick
}: {
  device: SafeDevice;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`select-row ${active ? "active" : ""}`} type="button" onClick={onClick}>
      <span className="row-main">
        {device.status === "online" ? <Wifi aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
        {device.name}
      </span>
      <span className="row-sub">{device.location}</span>
    </button>
  );
}

function StatusPill({ device }: { device: SafeDevice | null }) {
  const online = device?.status === "online";
  return (
    <div className={`status-pill ${online ? "online" : "offline"}`}>
      <CircleDot aria-hidden="true" />
      {online ? "Online" : "Offline"}
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="readout">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CommandLog({
  dashboard,
  onExpandScreenshot
}: {
  dashboard: DashboardState | null;
  onExpandScreenshot: (src: string) => void;
}) {
  return (
    <section className="command-log">
      <div className="log-head">
        <h2>Historico</h2>
        <span>{dashboard?.commands.length ?? 0}</span>
      </div>
      <div className="log-list">
        {dashboard?.commands.map((command) => (
          <article className="log-entry" key={command.id}>
            <div className="log-status">
              {command.status === "succeeded" ? (
                <CheckCircle2 aria-hidden="true" />
              ) : command.status === "failed" ? (
                <AlertTriangle aria-hidden="true" />
              ) : command.status === "waiting_confirmation" ? (
                <ShieldAlert aria-hidden="true" />
              ) : (
                <Activity aria-hidden="true" />
              )}
            </div>
            <div>
              <strong>{actionLabel(command.action)}</strong>
              <span>
                {command.deviceId} · {new Date(command.createdAt).toLocaleString("pt-BR")}
              </span>
              {command.status === "waiting_confirmation" ? <em>Aguardando confirmacao</em> : null}
              {command.error ? <em>{command.error}</em> : null}
            </div>
            {command.screenshot ? (
              <button
                type="button"
                className="thumb-button"
                onClick={() => onExpandScreenshot(command.screenshot as string)}
                title="Expandir captura"
              >
                <img className="thumb" src={command.screenshot} alt="Captura de tela do comando" />
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function SitePromptModal({
  prompt,
  onCancel,
  onConfirm
}: {
  prompt: SitePrompt;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="site-prompt-title">
        <div className="modal-icon">
          <ShieldAlert aria-hidden="true" />
        </div>
        <h2 id="site-prompt-title">{prompt.title}</h2>
        <p>{prompt.message}</p>
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            {prompt.cancelLabel}
          </button>
          <button className="danger-button" type="button" onClick={onConfirm}>
            {prompt.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function ConflictModal({
  conflict,
  profile,
  onCancel,
  onAdvance,
  onConfirm
}: {
  conflict: PendingConflict;
  profile: SafeSiteProfile | null;
  onCancel: () => void;
  onAdvance: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <div className="modal-icon">
          <ShieldAlert aria-hidden="true" />
        </div>
        <h2 id="conflict-title">{conflict.confirmation.title}</h2>
        <p>
          {profile?.name ?? "Este perfil"} ja aparece ativo em{" "}
          {conflict.conflict.activeDevices.map((device) => device.name).join(", ")}.
        </p>
        <p>{conflict.confirmation.message}</p>
        <p className="modal-warning">
          Confirmacao {conflict.step} de {conflict.confirmation.requiredConfirmations}
        </p>
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancelar
          </button>
          {conflict.step === 1 ? (
            <button className="danger-button" type="button" onClick={onAdvance}>
              Estou ciente
            </button>
          ) : (
            <button className="danger-button" type="button" onClick={onConfirm}>
              {conflict.confirmation.confirmLabel}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
