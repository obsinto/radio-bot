import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Camera,
  CheckCircle2,
  CircleDot,
  FolderOpen,
  Globe2,
  LogIn,
  Monitor,
  KeyRound,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  Radio,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  Wifi,
  WifiOff,
  X,
  Zap
} from "lucide-react";
import type {
  ApiError,
  AutostartEntry,
  CommandAction,
  CommandRecord,
  ConfirmationPrompt,
  DashboardState,
  ExecutableCandidate,
  ProfileConflict,
  SafeDevice,
  SafeSiteProfile,
  SafeWolGateway,
  ScheduleKind,
  ScheduleRecord,
  SitePrompt
} from "@radio-bot/shared";
import {
  createDevice,
  createProfile,
  createSchedule,
  createWolGateway,
  deleteSchedule,
  getState,
  login,
  runScheduleNow,
  sendCommand,
  updateSchedule,
  updateDeviceProfiles,
  updateDeviceWol
} from "./api.js";
import { SettingsModal } from "./SettingsModal.js";

const actionLabels: Record<CommandAction, string> = {
  open_site: "Abrir site",
  login: "Entrar",
  reload: "Recarregar",
  screenshot: "Captura de tela",
  get_state: "Estado",
  click_action: "Clicar acao",
  confirm_open_here: "Abrir nesta janela",
  play_radio: "Play",
  stop_playback: "Stop",
  shutdown: "Desligar",
  power_on: "Ligar computador",
  discover_executables: "Buscar aplicativos",
  configure_autostart_app: "Inicializar app",
  list_autostart_apps: "Listar inicializacao",
  remove_autostart_app: "Remover inicializacao"
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
    label: "Abrir e tocar",
    resolveAction: (profile) => (profile?.hasCredentials ? "login" : "open_site")
  },
  { key: "reload", icon: RefreshCw, resolveAction: () => "reload" },
  { key: "play", icon: Play, resolveAction: () => "play_radio" },
  { key: "stop", icon: Square, resolveAction: () => "stop_playback" },
  {
    key: "shutdown",
    icon: Power,
    label: "Desligar",
    resolveAction: () => "shutdown"
  },
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

function displayErrorMessage(error: unknown, fallback: string): string {
  const message = (error as ApiError | Error | undefined)?.message;
  if (message === "Failed to fetch") {
    return "Nao foi possivel conectar a API. Confira se o backend esta rodando e se VITE_API_URL aponta para a porta correta.";
  }
  return message ?? fallback;
}

function formatBackendTime(value?: string): string {
  if (!value) {
    return "--:--:--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
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
  const [shutdownConfirmOpen, setShutdownConfirmOpen] = useState(false);
  const [dismissedPromptIds, setDismissedPromptIds] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autostartOpen, setAutostartOpen] = useState(false);
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);

  const selectedDevice = useMemo(
    () => dashboard?.devices.find((device) => device.id === selectedDeviceId) ?? null,
    [dashboard, selectedDeviceId]
  );
  const allowedProfiles = useMemo(() => {
    if (!dashboard || !selectedDevice) {
      return [];
    }

    const allowedIds = new Set(selectedDevice.profileIds);
    return dashboard.profiles.filter((profile) => allowedIds.has(profile.id));
  }, [dashboard, selectedDevice]);
  const selectedProfile = useMemo(
    () => allowedProfiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [allowedProfiles, selectedProfileId]
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
        setSelectedDeviceId((current) =>
          current && state.devices.some((device) => device.id === current)
            ? current
            : state.devices[0]?.id ?? null
        );
        const promptCommand = state.commands.find((command) => {
          const sitePrompt = command.output?.sitePrompt as SitePrompt | undefined;
          return (
            command.status === "waiting_confirmation" &&
            typeof command.profileId === "string" &&
            sitePrompt?.type === "open_here" &&
            !dismissedPromptIds.includes(command.id)
          );
        });
        if (promptCommand) {
          setPendingSitePrompt({
            commandId: promptCommand.id,
            deviceId: promptCommand.deviceId,
            profileId: promptCommand.profileId ?? "",
            prompt: promptCommand.output?.sitePrompt as SitePrompt
          });
        }
      } catch (error) {
        const apiError = error as ApiError;
        if (apiError.code === "UNAUTHORIZED") {
          window.localStorage.removeItem("radio-bot-token");
          setToken(null);
        } else {
          setMessage(displayErrorMessage(error, "Falha ao atualizar estado."));
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

  useEffect(() => {
    if (!dashboard) {
      return;
    }

    if (!selectedDevice) {
      setSelectedProfileId(null);
      return;
    }

    const activeProfileId = selectedDevice.currentProfileId;
    const fallbackProfileId =
      activeProfileId && allowedProfiles.some((profile) => profile.id === activeProfileId)
        ? activeProfileId
        : allowedProfiles[0]?.id ?? null;

    setSelectedProfileId((current) =>
      current && allowedProfiles.some((profile) => profile.id === current)
        ? current
        : fallbackProfileId
    );
  }, [allowedProfiles, dashboard, selectedDevice]);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    try {
      const session = await login(email, password);
      window.localStorage.setItem("radio-bot-token", session.token);
      setToken(session.token);
      setEmail(session.email);
    } catch (error) {
      setMessage(displayErrorMessage(error, "Nao foi possivel entrar."));
    }
  }

  function openSettings() {
    if (!dashboard) {
      setMessage(
        "Configuracoes indisponiveis ate o estado inicial carregar. Confira a conexao com a API.",
        "error"
      );
      return;
    }
    setSettingsOpen(true);
  }

  async function runCommand(
    action: CommandAction,
    confirmations = 0,
    payload?: Record<string, unknown>
  ) {
    if (!token || !selectedDeviceId || !selectedProfile) {
      return;
    }

    setBusyAction(action);
    setMessage(null);
    try {
      await sendCommand({
        token,
        deviceId: selectedDeviceId,
        profileId: selectedProfile.id,
        action,
        payload,
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
        setMessage(displayErrorMessage(error, "Comando nao executado."));
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
      setMessage(displayErrorMessage(error, "Nao foi possivel continuar no site."));
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
              <input
                type="email"
                name="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Senha
              <input
                type="password"
                name="password"
                autoComplete="current-password"
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
        <div className="topbar-actions">
          <time
            className="backend-clock"
            dateTime={dashboard?.serverTime}
            title={dashboard?.serverTime ? `Horario do backend: ${dashboard.serverTime}` : "Horario do backend indisponivel"}
          >
            <span>Backend</span>
            <strong>{formatBackendTime(dashboard?.serverTime)}</strong>
          </time>
          <button
            className="icon-button"
            type="button"
            onClick={openSettings}
            title="Configuracoes"
          >
            <Settings aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={logout} title="Sair">
            <Power aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="rail">
          <SectionTitle icon={Monitor} label="Computadores" />
          <div className="stack">
            {dashboard?.devices.length === 0 ? (
              <p className="empty-state">Nenhum computador cadastrado.</p>
            ) : null}
            {dashboard?.devices.map((device) => (
              <DeviceButton
                key={device.id}
                device={device}
                active={device.id === selectedDeviceId}
                onClick={() => setSelectedDeviceId(device.id)}
              />
            ))}
          </div>

          <button className="admin-launch" type="button" onClick={openSettings}>
            <Settings aria-hidden="true" />
            Configuracoes
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

          <RadioSelector
            profiles={allowedProfiles}
            selectedProfileId={selectedProfile?.id ?? ""}
            disabled={!selectedDevice || allowedProfiles.length === 0}
            onChange={setSelectedProfileId}
            onOpenSettings={openSettings}
          />

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
                !selectedDevice ||
                !selectedProfile ||
                (requiresOnline && selectedDevice?.status !== "online");
              return (
                <button
                  key={button.key}
                  className="command-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (action === "shutdown") {
                      setShutdownConfirmOpen(true);
                      return;
                    }
                    void runCommand(action);
                  }}
                  title={label}
                >
                  <Icon aria-hidden="true" />
                  <span>{busyAction === action ? "Enviando" : label}</span>
                </button>
              );
            })}
          </div>

          <section className="system-tools">
            <div>
              <p className="eyebrow">Windows</p>
              <strong>Inicializacao de aplicativo</strong>
            </div>
            <button
              className="ghost-button"
              type="button"
              disabled={!selectedDevice || selectedDevice.status !== "online"}
              onClick={() => setAutostartOpen(true)}
            >
              <FolderOpen aria-hidden="true" />
              Aplicativos
            </button>
          </section>

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

      {settingsOpen && dashboard ? (
        <SettingsModal
          token={token}
          dashboard={dashboard}
          onClose={() => setSettingsOpen(false)}
          onNotice={setMessage}
          onRefresh={async () => setDashboard(await getState(token))}
          onSession={(session) => {
            window.localStorage.setItem("radio-bot-token", session.token);
            setToken(session.token);
            setEmail(session.email);
          }}
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

      {shutdownConfirmOpen ? (
        <ShutdownModal
          device={selectedDevice}
          onCancel={() => setShutdownConfirmOpen(false)}
          onConfirm={() => {
            setShutdownConfirmOpen(false);
            void runCommand("shutdown", 0, {
              delaySeconds: 60,
              force: false
            });
          }}
        />
      ) : null}

      {autostartOpen ? (
        <AutostartModal
          token={token}
          device={selectedDevice}
          onClose={() => setAutostartOpen(false)}
          onDashboard={setDashboard}
          onNotice={setMessage}
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

const weekDays = [
  { value: 0, label: "Dom" },
  { value: 1, label: "Seg" },
  { value: 2, label: "Ter" },
  { value: 3, label: "Qua" },
  { value: 4, label: "Qui" },
  { value: 5, label: "Sex" },
  { value: 6, label: "Sab" }
];

function SchedulesModal({
  token,
  schedules,
  runs,
  devices,
  profiles,
  onClose,
  onNotice,
  onRefresh
}: {
  token: string;
  schedules: ScheduleRecord[];
  runs: DashboardState["scheduleRuns"];
  devices: SafeDevice[];
  profiles: SafeSiteProfile[];
  onClose: () => void;
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("power_on_start");
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [timeOfDay, setTimeOfDay] = useState("07:00");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [daysOfWeek, setDaysOfWeek] = useState([1, 2, 3, 4, 5]);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const selectedDevice = devices.find((device) => device.id === deviceId) ?? null;
  const allowedProfiles = selectedDevice
    ? profiles.filter((profile) => selectedDevice.profileIds.includes(profile.id))
    : profiles;
  const effectiveProfileId = allowedProfiles.some((profile) => profile.id === profileId)
    ? profileId
    : allowedProfiles[0]?.id ?? "";

  function toggleDay(day: number) {
    setDaysOfWeek((current) =>
      current.includes(day)
        ? current.filter((item) => item !== day)
        : [...current, day].sort((a, b) => a - b)
    );
  }

  async function submitSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    try {
      await createSchedule({
        token,
        schedule: {
          name,
          kind,
          deviceId,
          profileId: kind === "power_on_start" ? effectiveProfileId : null,
          timezone,
          timeOfDay,
          daysOfWeek,
          status: "enabled"
        }
      });
      setName("");
      onNotice("Agendamento criado.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel criar o agendamento.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleSchedule(schedule: ScheduleRecord) {
    setBusyId(schedule.id);
    try {
      await updateSchedule({
        token,
        scheduleId: schedule.id,
        schedule: {
          status: schedule.status === "enabled" ? "disabled" : "enabled"
        }
      });
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel atualizar o agendamento.");
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(scheduleId: string) {
    setBusyId(scheduleId);
    try {
      await runScheduleNow({ token, scheduleId });
      onNotice("Agendamento enviado para execucao.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel executar agora.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(scheduleId: string) {
    setBusyId(scheduleId);
    try {
      await deleteSchedule({ token, scheduleId });
      onNotice("Agendamento removido.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel remover.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedules-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Automacao</p>
            <h2 id="schedules-title">Agendamentos</h2>
          </div>
          <button className="icon-button modal-close" type="button" onClick={onClose} title="Fechar">
            <X aria-hidden="true" />
          </button>
        </div>

        <form className="mini-form wol-gateway-form" onSubmit={submitSchedule}>
          <label>
            Nome
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Palmeirinha FM manha"
            />
          </label>
          <label>
            Tipo
            <select value={kind} onChange={(event) => setKind(event.target.value as ScheduleKind)}>
              <option value="power_on_start">Ligar e tocar</option>
              <option value="shutdown">Desligar</option>
            </select>
          </label>
          <label>
            Computador
            <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} required>
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          {kind === "power_on_start" ? (
            <label>
              Radio
              <select
                value={effectiveProfileId}
                onChange={(event) => setProfileId(event.target.value)}
                required
              >
                {allowedProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Horario
            <input
              required
              type="time"
              value={timeOfDay}
              onChange={(event) => setTimeOfDay(event.target.value)}
            />
          </label>
          <label>
            Timezone
            <input
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </label>
          <div className="profile-checkbox-list">
            {weekDays.map((day) => (
              <label className="profile-checkbox" key={day.value}>
                <input
                  type="checkbox"
                  checked={daysOfWeek.includes(day.value)}
                  onChange={() => toggleDay(day.value)}
                />
                <span>{day.label}</span>
              </label>
            ))}
          </div>
          <button
            className="small-action"
            type="submit"
            disabled={creating || devices.length === 0 || (kind === "power_on_start" && !effectiveProfileId)}
          >
            <Plus aria-hidden="true" />
            {creating ? "Criando" : "Criar"}
          </button>
        </form>

        <div className="wol-grid">
          {schedules.length === 0 ? <p className="muted">Nenhum agendamento cadastrado.</p> : null}
          {schedules.map((schedule) => {
            const device = devices.find((item) => item.id === schedule.deviceId);
            const profile = profiles.find((item) => item.id === schedule.profileId);
            const lastRun = runs.find((run) => run.scheduleId === schedule.id);
            return (
              <article className="wol-row" key={schedule.id}>
                <header>
                  <strong>{schedule.name}</strong>
                  <span>
                    {schedule.kind === "power_on_start" ? "Ligar e tocar" : "Desligar"} -{" "}
                    {schedule.status === "enabled" ? "ativo" : "inativo"}
                  </span>
                </header>
                <p className="muted">
                  {device?.name ?? schedule.deviceId}
                  {profile ? ` - ${profile.name}` : ""} - {schedule.timeOfDay} -{" "}
                  {schedule.daysOfWeek
                    .map((day) => weekDays.find((item) => item.value === day)?.label)
                    .filter(Boolean)
                    .join(", ")}
                </p>
                <p className="muted">
                  Proxima: {formatDateTime(schedule.nextRunAt)} | Ultima:{" "}
                  {lastRun ? `${lastRun.status} em ${formatDateTime(lastRun.startedAt)}` : "-"}
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={busyId === schedule.id}
                    onClick={() => toggleSchedule(schedule)}
                  >
                    {schedule.status === "enabled" ? "Desativar" : "Ativar"}
                  </button>
                  <button
                    type="button"
                    className="small-action"
                    disabled={busyId === schedule.id}
                    onClick={() => runNow(schedule.id)}
                  >
                    <Play aria-hidden="true" />
                    Executar agora
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busyId === schedule.id}
                    onClick={() => remove(schedule.id)}
                  >
                    <Trash2 aria-hidden="true" />
                    Excluir
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("pt-BR");
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
  const [siteUrl, setSiteUrl] = useState("");
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

function RadioSelector({
  profiles,
  selectedProfileId,
  disabled,
  onChange,
  onOpenSettings
}: {
  profiles: SafeSiteProfile[];
  selectedProfileId: string;
  disabled: boolean;
  onChange: (profileId: string) => void;
  onOpenSettings: () => void;
}) {
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;

  return (
    <section className="radio-selector" aria-labelledby="radio-selector-title">
      <div className="radio-selector-head">
        <div>
          <p className="eyebrow" id="radio-selector-title">
            Radio
          </p>
          <strong>{selectedProfile?.name ?? "Nenhuma radio vinculada"}</strong>
        </div>
        <span>{profiles.length}</span>
      </div>

      {profiles.length > 0 ? (
        <label className="radio-select-field">
          <Radio aria-hidden="true" />
          <select
            value={selectedProfileId}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="radio-empty">
          <span>Nenhuma radio vinculada a este computador.</span>
          <button className="ghost-button compact-action" type="button" onClick={onOpenSettings}>
            <Settings aria-hidden="true" />
            Configuracoes
          </button>
        </div>
      )}

      {selectedProfile ? (
        <div className="radio-selector-meta">
          <span>{selectedProfile.usernameLabel}</span>
          <a href={selectedProfile.siteUrl} target="_blank" rel="noreferrer">
            {selectedProfile.siteUrl}
          </a>
        </div>
      ) : null}
    </section>
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

function ShutdownModal({
  device,
  onCancel,
  onConfirm
}: {
  device: SafeDevice | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="shutdown-title">
        <div className="modal-icon">
          <Power aria-hidden="true" />
        </div>
        <h2 id="shutdown-title">Desligar computador</h2>
        <p>
          O comando vai desligar {device?.name ?? "o computador selecionado"} em aproximadamente
          1 minuto. O agente local precisa estar online e ter permissao no sistema operacional.
        </p>
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onCancel}>
            Cancelar
          </button>
          <button className="danger-button" type="button" onClick={onConfirm}>
            Desligar
          </button>
        </div>
      </section>
    </div>
  );
}

function AutostartModal({
  token,
  device,
  onClose,
  onDashboard,
  onNotice
}: {
  token: string;
  device: SafeDevice | null;
  onClose: () => void;
  onDashboard: (dashboard: DashboardState) => void;
  onNotice: (message: string | null, tone?: "error" | "success") => void;
}) {
  const [query, setQuery] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [candidates, setCandidates] = useState<ExecutableCandidate[]>([]);
  const [autostartApps, setAutostartApps] = useState<AutostartEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastConfigured, setLastConfigured] = useState<string | null>(null);

  const online = device?.status === "online";
  const deviceId = device?.id ?? null;

  async function runAgentCommand(
    action:
      | "discover_executables"
      | "configure_autostart_app"
      | "list_autostart_apps"
      | "remove_autostart_app",
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<CommandRecord> {
    if (!device) {
      throw new Error("Selecione um computador.");
    }
    if (device.status !== "online") {
      throw new Error("O agente precisa estar online.");
    }

    const command = await sendCommand({
      token,
      deviceId: device.id,
      action,
      payload
    });
    const result = await waitForCommandResult(token, command.id, timeoutMs);
    onDashboard(result.dashboard);
    if (result.command.status === "failed") {
      throw new Error(result.command.error ?? "Comando do agente falhou.");
    }
    return result.command;
  }

  async function searchExecutables() {
    setBusy("search");
    setLastConfigured(null);
    onNotice(null);
    try {
      const command = await runAgentCommand(
        "discover_executables",
        {
          query: query.trim(),
          limit: 80
        },
        65000
      );
      const nextCandidates = readExecutableCandidates(command.output?.candidates);
      setCandidates(nextCandidates);
      onNotice(`${nextCandidates.length} aplicativo(s) encontrado(s).`, "success");
    } catch (error) {
      onNotice(displayErrorMessage(error, "Nao foi possivel buscar aplicativos."));
    } finally {
      setBusy(null);
    }
  }

  async function configureAutostart(app: {
    name?: string;
    path: string;
    workingDir?: string;
  }) {
    setBusy(app.path);
    setLastConfigured(null);
    onNotice(null);
    try {
      const command = await runAgentCommand(
        "configure_autostart_app",
        {
          name: app.name,
          path: app.path,
          workingDir: app.workingDir
        },
        35000
      );
      const taskName = outputString(command.output, "taskName") ?? "RadioBOT Autostart";
      setLastConfigured(taskName);
      onNotice(`Inicializacao configurada: ${taskName}.`, "success");
      void loadAutostartApps();
    } catch (error) {
      onNotice(displayErrorMessage(error, "Nao foi possivel configurar a inicializacao."));
    } finally {
      setBusy(null);
    }
  }

  async function loadAutostartApps() {
    if (device?.status !== "online") {
      setAutostartApps([]);
      return;
    }
    try {
      const command = await runAgentCommand("list_autostart_apps", {}, 35000);
      setAutostartApps(readAutostartEntries(command.output?.tasks));
    } catch (error) {
      onNotice(displayErrorMessage(error, "Nao foi possivel listar a inicializacao."));
    }
  }

  async function removeAutostart(taskName: string) {
    setBusy(`remove:${taskName}`);
    onNotice(null);
    try {
      await runAgentCommand("remove_autostart_app", { taskName }, 35000);
      setAutostartApps((current) => current.filter((entry) => entry.taskName !== taskName));
      if (lastConfigured === taskName) {
        setLastConfigured(null);
      }
      onNotice(`Inicializacao removida: ${taskName}.`, "success");
    } catch (error) {
      onNotice(displayErrorMessage(error, "Nao foi possivel remover a inicializacao."));
    } finally {
      setBusy(null);
    }
  }

  // Carrega a lista de apps ja configurados ao abrir o modal ou trocar de
  // computador online. Evita o aviso de dependencia faltando reusando o id.
  useEffect(() => {
    void loadAutostartApps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, online]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal autostart-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="autostart-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Windows</p>
            <h2 id="autostart-title">Inicializacao de aplicativo</h2>
          </div>
          <button className="icon-button modal-close" type="button" onClick={onClose} title="Fechar">
            <X aria-hidden="true" />
          </button>
        </div>

        <div className="autostart-target">
          <StatusPill device={device} />
          <span>{device?.name ?? "Nenhum computador selecionado"}</span>
        </div>

        <form
          className="autostart-search"
          onSubmit={(event) => {
            event.preventDefault();
            void searchExecutables();
          }}
        >
          <label>
            Buscar aplicativo
            <span>
              <Search aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Nome do programa"
                disabled={!online || busy !== null}
              />
            </span>
          </label>
          <button className="small-action" type="submit" disabled={!online || busy !== null}>
            <Search aria-hidden="true" />
            {busy === "search" ? "Buscando" : "Buscar"}
          </button>
        </form>

        <form
          className="autostart-manual"
          onSubmit={(event) => {
            event.preventDefault();
            const path = manualPath.trim();
            if (path) {
              void configureAutostart({ path });
            }
          }}
        >
          <label>
            Caminho manual do .exe
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder="C:\\Program Files\\Sistema\\Sistema.exe"
              disabled={!online || busy !== null}
            />
          </label>
          <button
            className="ghost-button"
            type="submit"
            disabled={!online || busy !== null || manualPath.trim().length === 0}
          >
            <Save aria-hidden="true" />
            Configurar
          </button>
        </form>

        {lastConfigured ? (
          <div className="inline-alert tone-success autostart-result">
            <CheckCircle2 aria-hidden="true" />
            <span>{lastConfigured}</span>
          </div>
        ) : null}

        <div className="app-results">
          <div className="list-heading">
            Apps na inicializacao
            <span>{autostartApps.length}</span>
          </div>
          {autostartApps.length === 0 ? (
            <p className="empty-state">
              {online ? "Nenhum app configurado para iniciar." : "Agente offline."}
            </p>
          ) : (
            autostartApps.map((entry) => (
              <article className="app-result-row" key={entry.taskName}>
                <div>
                  <strong>{autostartDisplayName(entry)}</strong>
                  <span>{entry.path ?? entry.taskName}</span>
                  <em>{entry.state ? `Tarefa: ${entry.state}` : "Tarefa agendada"}</em>
                </div>
                <button
                  className="small-action danger"
                  type="button"
                  disabled={!online || busy !== null}
                  onClick={() => void removeAutostart(entry.taskName)}
                >
                  <Trash2 aria-hidden="true" />
                  {busy === `remove:${entry.taskName}` ? "Removendo" : "Remover"}
                </button>
              </article>
            ))
          )}
        </div>

        <div className="app-results">
          <div className="list-heading">
            Aplicativos encontrados
            <span>{candidates.length}</span>
          </div>
          {candidates.length === 0 ? (
            <p className="empty-state">
              {online ? "Nenhum aplicativo listado ainda." : "Agente offline."}
            </p>
          ) : (
            candidates.map((app) => (
              <article className="app-result-row" key={app.id}>
                <div>
                  <strong>{app.name}</strong>
                  <span>{app.path}</span>
                  <em>{sourceLabel(app.source)}</em>
                </div>
                <button
                  className="small-action"
                  type="button"
                  disabled={!online || busy !== null}
                  onClick={() => void configureAutostart(app)}
                >
                  <Save aria-hidden="true" />
                  {busy === app.path ? "Configurando" : "Usar"}
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

async function waitForCommandResult(
  token: string,
  commandId: string,
  timeoutMs: number
): Promise<{ command: CommandRecord; dashboard: DashboardState }> {
  const deadline = Date.now() + timeoutMs;
  let lastDashboard: DashboardState | null = null;

  while (Date.now() < deadline) {
    const dashboard = await getState(token);
    lastDashboard = dashboard;
    const command = dashboard.commands.find((item) => item.id === commandId);
    if (
      command &&
      (command.status === "succeeded" ||
        command.status === "failed" ||
        command.status === "waiting_confirmation")
    ) {
      return {
        command,
        dashboard
      };
    }
    await delay(1000);
  }

  if (lastDashboard) {
    const command = lastDashboard.commands.find((item) => item.id === commandId);
    if (command) {
      return {
        command,
        dashboard: lastDashboard
      };
    }
  }

  throw new Error("Tempo limite aguardando resposta do agente.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const AUTOSTART_TASK_PREFIX = "RadioBOT Autostart";

function autostartDisplayName(entry: AutostartEntry): string {
  const stripped = entry.taskName
    .replace(/^RadioBOT Autostart\s*-\s*/i, "")
    .replace(/^RadioBOT Autostart\s*/i, "")
    .trim();
  return stripped.length > 0 ? stripped : entry.taskName;
}

function readAutostartEntries(value: unknown): AutostartEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const entry = item as Partial<AutostartEntry>;
    if (typeof entry.taskName !== "string" || !entry.taskName.startsWith(AUTOSTART_TASK_PREFIX)) {
      return [];
    }
    return [
      {
        taskName: entry.taskName,
        path: typeof entry.path === "string" ? entry.path : null,
        workingDir: typeof entry.workingDir === "string" ? entry.workingDir : null,
        state: typeof entry.state === "string" ? entry.state : null
      }
    ];
  });
}

function readExecutableCandidates(value: unknown): ExecutableCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const candidate = item as Partial<ExecutableCandidate>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.path !== "string" ||
      typeof candidate.workingDir !== "string" ||
      (candidate.source !== "start_menu" &&
        candidate.source !== "registry" &&
        candidate.source !== "common_path")
    ) {
      return [];
    }
    return [
      {
        id: candidate.id,
        name: candidate.name,
        path: candidate.path,
        workingDir: candidate.workingDir,
        source: candidate.source,
        publisher: typeof candidate.publisher === "string" ? candidate.publisher : null,
        version: typeof candidate.version === "string" ? candidate.version : null
      }
    ];
  });
}

function outputString(output: Record<string, unknown> | null, key: string): string | null {
  const value = output?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceLabel(source: ExecutableCandidate["source"]): string {
  if (source === "start_menu") {
    return "Menu Iniciar";
  }
  if (source === "registry") {
    return "Registro";
  }
  return "Pastas comuns";
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
