import { useEffect, useState } from "react";
import {
  CalendarClock,
  KeyRound,
  Monitor,
  Pencil,
  Play,
  Plus,
  Radio,
  Save,
  Settings,
  Trash2,
  X,
  Zap
} from "lucide-react";
import type {
  ApiError,
  DashboardState,
  SafeDevice,
  SafeSiteProfile,
  SafeWolGateway,
  ScheduleKind,
  ScheduleRecord
} from "@radio-bot/shared";
import {
  createDevice,
  createProfile,
  createSchedule,
  createWolGateway,
  deleteSchedule,
  runScheduleNow,
  updateDevice,
  updateDeviceProfiles,
  updateDeviceWol,
  updateProfile,
  updateSchedule,
  updateWolGateway
} from "./api.js";

type ProfileMode = "direct" | "login";
type Tab = "radios" | "devices" | "schedules" | "gateways";

const palmeirinhaUrl =
  "https://app.radios.srv.br/?r=28357A55656E59517E735956676158546B73515E6370598DACD1EA";

const weekDays = [
  { value: 0, label: "Dom" },
  { value: 1, label: "Seg" },
  { value: 2, label: "Ter" },
  { value: 3, label: "Qua" },
  { value: 4, label: "Qui" },
  { value: 5, label: "Sex" },
  { value: 6, label: "Sab" }
];

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString("pt-BR");
}

function statusText(status: string): string {
  return status === "online" ? "Online" : "Offline";
}

export function SettingsModal({
  token,
  dashboard,
  onClose,
  onNotice,
  onRefresh
}: {
  token: string;
  dashboard: DashboardState;
  onClose: () => void;
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("radios");

  const tabs: Array<{
    id: Tab;
    label: string;
    count: number;
    icon: typeof Radio;
  }> = [
    { id: "radios", label: "Radios", count: dashboard.profiles.length, icon: Radio },
    { id: "devices", label: "Computadores", count: dashboard.devices.length, icon: Monitor },
    {
      id: "schedules",
      label: "Agendamentos",
      count: dashboard.schedules.length,
      icon: CalendarClock
    },
    { id: "gateways", label: "Gateways WOL", count: dashboard.wolGateways.length, icon: Zap }
  ];

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
    <div
      className="modal-backdrop settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="modal admin-modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <aside className="settings-sidebar">
          <div className="settings-header">
            <Settings aria-hidden="true" />
            <div>
              <span>Admin</span>
              <h2 id="settings-title">Configuracoes</h2>
            </div>
          </div>

          <nav className="settings-nav" aria-label="Secoes de configuracao">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={activeTab === tab.id ? "active" : ""}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon aria-hidden="true" />
                  <span>{tab.label}</span>
                  <em>{tab.count}</em>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="settings-content">
          <div className="settings-content-header">
            <div>
              <p className="eyebrow">Configuracao do painel</p>
              <h3>{tabs.find((tab) => tab.id === activeTab)?.label}</h3>
            </div>
            <button className="icon-button modal-close" type="button" onClick={onClose} title="Fechar">
              <X aria-hidden="true" />
            </button>
          </div>

          <div className="settings-scroll-area">
            {activeTab === "radios" ? (
              <RadiosTab
                token={token}
                profiles={dashboard.profiles}
                onNotice={onNotice}
                onRefresh={onRefresh}
              />
            ) : null}
            {activeTab === "devices" ? (
              <DevicesTab
                token={token}
                devices={dashboard.devices}
                profiles={dashboard.profiles}
                gateways={dashboard.wolGateways}
                onNotice={onNotice}
                onRefresh={onRefresh}
              />
            ) : null}
            {activeTab === "schedules" ? (
              <SchedulesTab
                token={token}
                schedules={dashboard.schedules}
                runs={dashboard.scheduleRuns}
                devices={dashboard.devices}
                profiles={dashboard.profiles}
                onNotice={onNotice}
                onRefresh={onRefresh}
              />
            ) : null}
            {activeTab === "gateways" ? (
              <GatewaysTab
                token={token}
                devices={dashboard.devices}
                gateways={dashboard.wolGateways}
                onNotice={onNotice}
                onRefresh={onRefresh}
              />
            ) : null}
          </div>
        </main>
      </section>
    </div>
  );
}

function RadiosTab({
  token,
  profiles,
  onNotice,
  onRefresh
}: {
  token: string;
  profiles: SafeSiteProfile[];
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [profileName, setProfileName] = useState("");
  const [profileMode, setProfileMode] = useState<ProfileMode>("direct");
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [recentProfileId, setRecentProfileId] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);

  const normalizedName = profileName.trim().toLocaleLowerCase("pt-BR");
  const normalizedUrl = siteUrl.trim();
  const duplicateProfile = profiles.find(
    (profile) =>
      profile.id !== editingProfileId &&
      (profile.name.trim().toLocaleLowerCase("pt-BR") === normalizedName ||
        profile.siteUrl.trim() === normalizedUrl)
  );
  const canSubmit =
    profileName.trim().length > 0 &&
    normalizedUrl.length > 0 &&
    !duplicateProfile &&
    !creating;

  function clearForm() {
    setProfileName("");
    setProfileMode("direct");
    setSiteUrl("");
    setUsername("");
    setPassword("");
    setEditingProfileId(null);
  }

  function fillPalmeirinhaPreset() {
    setProfileName("Palmeirinha FM");
    setProfileMode("direct");
    setSiteUrl(palmeirinhaUrl);
    setUsername("");
    setPassword("");
  }

  function fillOliveiraPreset() {
    setProfileName("Oliveira FM");
    setProfileMode("direct");
    setSiteUrl("https://www.oliveirafm.com.br/");
    setUsername("");
    setPassword("");
  }

  async function submitProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setCreating(true);
    const profileIdBeingEdited = editingProfileId;
    try {
      const profile = profileIdBeingEdited
        ? await updateProfile({
            token,
            profileId: profileIdBeingEdited,
            name: profileName.trim(),
            siteUrl: normalizedUrl
          })
        : await createProfile({
            token,
            name: profileName.trim(),
            siteUrl: normalizedUrl,
            username: profileMode === "login" ? username : "",
            password: profileMode === "login" ? password : ""
          });
      setRecentProfileId(profile.id);
      clearForm();
      onNotice(
        profileIdBeingEdited
          ? "Radio atualizada."
          : "Radio adicionada. Vincule aos computadores na aba Computadores.",
        "success"
      );
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel adicionar radio.");
    } finally {
      setCreating(false);
    }
  }

  function startProfileEdit(profile: SafeSiteProfile) {
    setEditingProfileId(profile.id);
    setProfileName(profile.name);
    setProfileMode("direct");
    setSiteUrl(profile.siteUrl);
    setUsername("");
    setPassword("");
  }

  return (
    <div className="tab-container radio-tab">
      <form className="mini-form radio-form" onSubmit={submitProfile}>
        <div className="form-heading">
          <div>
            <strong>{editingProfileId ? "Editar radio" : "Adicionar radio"}</strong>
            <span>
              {editingProfileId
                ? "A edicao altera nome e URL sem mexer nas credenciais salvas."
                : "Escolha um modelo ou preencha uma URL propria."}
            </span>
          </div>
          <button className="ghost-button compact-action" type="button" onClick={clearForm}>
            Limpar
          </button>
        </div>

        {!editingProfileId ? (
          <>
            <div className="preset-grid" aria-label="Modelos de radio">
              <button className="preset-card" type="button" onClick={fillPalmeirinhaPreset}>
                <Radio aria-hidden="true" />
                <span>
                  <strong>Palmeirinha FM</strong>
                  <em>Link direto do player</em>
                </span>
              </button>
              <button className="preset-card secondary-preset" type="button" onClick={fillOliveiraPreset}>
                <Radio aria-hidden="true" />
                <span>
                  <strong>Oliveira FM</strong>
                  <em>Site publico, usar Play</em>
                </span>
              </button>
            </div>

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
          </>
        ) : null}

        <div className="field-grid two-columns">
          <label>
            Nome
            <input
              required
              name="profileName"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              placeholder="Palmeirinha FM"
            />
          </label>
          <label>
            URL
            <input
              required
              name="siteUrl"
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
              placeholder={palmeirinhaUrl}
            />
          </label>
          {!editingProfileId && profileMode === "login" ? (
            <>
              <label>
                Usuario
                <input
                  required
                  name="username"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="usuario"
                />
              </label>
              <label>
                Senha
                <input
                  required
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="senha"
                />
              </label>
            </>
          ) : null}
        </div>

        {duplicateProfile ? (
          <p className="field-note tone-warning">
            Ja existe uma radio com este nome ou URL: {duplicateProfile.name}.
          </p>
        ) : null}

        <div className="form-actions split-actions">
          <button className="small-action" type="submit" disabled={!canSubmit}>
            <Plus aria-hidden="true" />
            {creating
              ? editingProfileId
                ? "Salvando"
                : "Adicionando"
              : editingProfileId
                ? "Salvar radio"
                : "Adicionar radio"}
          </button>
        </div>
      </form>

      <section className="radio-list" aria-label="Radios cadastradas">
        <div className="list-heading">
          <strong>Radios cadastradas</strong>
          <span>{profiles.length}</span>
        </div>
        {profiles.length === 0 ? <p className="empty-state">Nenhuma radio cadastrada.</p> : null}
        {profiles.map((profile) => (
          <article
            className={`wol-row radio-row ${profile.id === recentProfileId ? "recent" : ""}`}
            key={profile.id}
          >
            <header>
              <strong>{profile.name}</strong>
              <span className={`status-badge ${profile.hasCredentials ? "disabled" : "enabled"}`}>
                {profile.hasCredentials ? "Requer login" : "Acesso direto"}
              </span>
            </header>
            <p className="muted">{profile.siteUrl}</p>
            {profile.hasCredentials ? <p className="muted">Usuario: {profile.usernameLabel}</p> : null}
            <div className="form-actions">
              <button className="ghost-button" type="button" onClick={() => startProfileEdit(profile)}>
                <Pencil aria-hidden="true" />
                Editar
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function DevicesTab({
  token,
  devices,
  profiles,
  gateways,
  onNotice,
  onRefresh
}: {
  token: string;
  devices: SafeDevice[];
  profiles: SafeSiteProfile[];
  gateways: SafeWolGateway[];
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [deviceName, setDeviceName] = useState("");
  const [location, setLocation] = useState("");
  const [newDeviceProfileIds, setNewDeviceProfileIds] = useState<string[]>([]);
  const [generatedToken, setGeneratedToken] = useState<{
    deviceId: string;
    token: string;
  } | null>(null);
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        name: string;
        location: string;
        profileIds: string[];
        mac: string;
        broadcast: string;
        gatewayId: string;
      }
    >
  >({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    setDrafts((current) => {
      const next: Record<
        string,
        {
          name: string;
          location: string;
          profileIds: string[];
          mac: string;
          broadcast: string;
          gatewayId: string;
        }
      > = {};
      for (const device of devices) {
        next[device.id] = current[device.id] ?? {
          name: device.name,
          location: device.location,
          profileIds: [...device.profileIds],
          mac: device.macAddress ?? "",
          broadcast: device.broadcastAddress ?? "",
          gatewayId: device.wolGatewayId ?? ""
        };
      }
      return next;
    });
  }, [devices]);

  async function submitDevice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const device = await createDevice({
        token,
        name: deviceName,
        location,
        profileIds: newDeviceProfileIds
      });
      setDrafts((current) => ({
        ...current,
        [device.id]: {
          name: device.name,
          location: device.location,
          profileIds: device.profileIds,
          mac: device.macAddress ?? "",
          broadcast: device.broadcastAddress ?? "",
          gatewayId: device.wolGatewayId ?? ""
        }
      }));
      setDeviceName("");
      setLocation("");
      setNewDeviceProfileIds([]);
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

  function toggleNewDeviceProfile(selectedProfileId: string) {
    setNewDeviceProfileIds((current) =>
      current.includes(selectedProfileId)
        ? current.filter((id) => id !== selectedProfileId)
        : [...current, selectedProfileId]
    );
  }

  function toggleProfile(deviceId: string, selectedProfileId: string) {
    setDrafts((current) => {
      const draft = current[deviceId];
      if (!draft) {
        return current;
      }
      const profileIds = draft.profileIds.includes(selectedProfileId)
        ? draft.profileIds.filter((id) => id !== selectedProfileId)
        : [...draft.profileIds, selectedProfileId];
      return { ...current, [deviceId]: { ...draft, profileIds } };
    });
  }

  async function save(deviceId: string) {
    const draft = drafts[deviceId];
    if (!draft) {
      return;
    }
    setSavingId(deviceId);
    try {
      await updateDevice({
        token,
        deviceId,
        name: draft.name,
        location: draft.location
      });
      await updateDeviceProfiles({
        token,
        deviceId,
        profileIds: draft.profileIds
      });
      await updateDeviceWol({
        token,
        deviceId,
        macAddress: draft.mac,
        broadcastAddress: draft.broadcast,
        wolGatewayId: draft.gatewayId
      });
      onNotice("Configuracoes salvas.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel salvar configuracoes.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="tab-container">
      <form className="mini-form" onSubmit={submitDevice}>
        <div className="form-heading">
          <div>
            <strong>Adicionar computador</strong>
            <span>Um computador pode tocar uma ou mais radios.</span>
          </div>
        </div>

        <div className="field-grid two-columns">
          <label>
            Nome
            <input
              required
              name="deviceName"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="Estudio 1"
            />
          </label>
          <label>
            Local
            <input
              required
              name="deviceLocation"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Sala principal"
            />
          </label>
        </div>

        <fieldset className="profile-choice-panel">
          <legend>Radios permitidas</legend>
          {profiles.length === 0 ? (
            <p className="muted">Nenhuma radio cadastrada.</p>
          ) : (
            <div className="profile-checkbox-list">
              {profiles.map((profile) => (
                <label key={profile.id} className="profile-checkbox">
                  <input
                    type="checkbox"
                    name="new-device-profiles"
                    checked={newDeviceProfileIds.includes(profile.id)}
                    onChange={() => toggleNewDeviceProfile(profile.id)}
                  />
                  <span>{profile.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <button className="small-action form-submit" type="submit">
          <Plus aria-hidden="true" />
          Adicionar computador
        </button>
      </form>

      {generatedToken ? (
        <div className="token-box token-box-spaced">
          <KeyRound aria-hidden="true" />
          <div>
            <p>Credenciais do agente neste computador:</p>
            <code>
              DEVICE_ID={generatedToken.deviceId}
              {"\n"}DEVICE_TOKEN={generatedToken.token}
            </code>
          </div>
        </div>
      ) : null}

      <div className="wol-grid">
        {devices.length === 0 ? <p className="empty-state">Nenhum computador cadastrado.</p> : null}
        {devices.map((device) => {
          const draft = drafts[device.id] ?? {
            name: device.name,
            location: device.location,
            profileIds: [],
            mac: "",
            broadcast: "",
            gatewayId: ""
          };
          const isOnline = device.status === "online";
          return (
            <article className="wol-row" key={device.id}>
              <header>
                <div className="entity-title">
                  <strong>{device.name}</strong>
                  <span
                    className={`status-indicator ${isOnline ? "online" : "offline"}`}
                    title={statusText(device.status)}
                  />
                </div>
                <span>{device.location}</span>
              </header>

              <div className="config-subgrid">
                <div className="config-block">
                  <strong>Identificacao</strong>
                  <label>
                    Nome
                    <input
                      name={`device-name-${device.id}`}
                      value={draft.name}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [device.id]: { ...draft, name: event.target.value }
                        }))
                      }
                    />
                  </label>
                  <label>
                    Local
                    <input
                      name={`device-location-${device.id}`}
                      value={draft.location}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [device.id]: { ...draft, location: event.target.value }
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="config-block">
                  <strong>Radios vinculadas</strong>
                  {profiles.length === 0 ? (
                    <p className="muted">Nenhuma radio cadastrada.</p>
                  ) : (
                    <div className="profile-checkbox-list">
                      {profiles.map((profile) => (
                        <label key={profile.id} className="profile-checkbox">
                          <input
                            type="checkbox"
                            name={`profile-${device.id}`}
                            checked={draft.profileIds.includes(profile.id)}
                            onChange={() => toggleProfile(device.id, profile.id)}
                          />
                          <span>{profile.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <div className="config-block">
                  <strong>Wake on LAN</strong>
                  <label>
                    Gateway ESP32
                    <select
                      name={`gateway-${device.id}`}
                      value={draft.gatewayId}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [device.id]: { ...draft, gatewayId: event.target.value }
                        }))
                      }
                    >
                      <option value="">Nenhum gateway</option>
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
                      name={`mac-${device.id}`}
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
                      name={`broadcast-${device.id}`}
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
                </div>
              </div>

              <div className="form-actions">
                <button
                  type="button"
                  className="small-action"
                  disabled={savingId === device.id}
                  onClick={() => save(device.id)}
                >
                  <Save aria-hidden="true" />
                  {savingId === device.id ? "Salvando" : "Salvar configuracoes"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function SchedulesTab({
  token,
  schedules,
  runs,
  devices,
  profiles,
  onNotice,
  onRefresh
}: {
  token: string;
  schedules: ScheduleRecord[];
  runs: DashboardState["scheduleRuns"];
  devices: SafeDevice[];
  profiles: SafeSiteProfile[];
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
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);

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

  function clearScheduleForm() {
    setEditingScheduleId(null);
    setName("");
    setKind("power_on_start");
    setDeviceId(devices[0]?.id ?? "");
    setProfileId(profiles[0]?.id ?? "");
    setTimeOfDay("07:00");
    setTimezone("America/Sao_Paulo");
    setDaysOfWeek([1, 2, 3, 4, 5]);
  }

  function startScheduleEdit(schedule: ScheduleRecord) {
    setEditingScheduleId(schedule.id);
    setName(schedule.name);
    setKind(schedule.kind);
    setDeviceId(schedule.deviceId);
    setProfileId(schedule.profileId ?? "");
    setTimeOfDay(schedule.timeOfDay);
    setTimezone(schedule.timezone);
    setDaysOfWeek(schedule.daysOfWeek);
  }

  async function submitSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    try {
      const schedule = {
        name,
        kind,
        deviceId,
        profileId: kind === "power_on_start" ? effectiveProfileId : null,
        timezone,
        timeOfDay,
        daysOfWeek
      };
      if (editingScheduleId) {
        await updateSchedule({
          token,
          scheduleId: editingScheduleId,
          schedule
        });
        onNotice("Agendamento atualizado.", "success");
      } else {
        await createSchedule({
          token,
          schedule: {
            ...schedule,
            status: "enabled"
          }
        });
        onNotice("Agendamento criado.", "success");
      }
      clearScheduleForm();
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel salvar o agendamento.");
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
    if (!window.confirm("Excluir este agendamento?")) {
      return;
    }
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
    <div className="tab-container">
      <form className="mini-form" onSubmit={submitSchedule}>
        <div className="form-heading">
          <div>
            <strong>{editingScheduleId ? "Editar agendamento" : "Criar agendamento"}</strong>
            <span>
              {editingScheduleId
                ? "Salve computador, radio e horario desta rotina."
                : "Cada agendamento escolhe computador, radio e horario."}
            </span>
          </div>
          {editingScheduleId ? (
            <button className="ghost-button compact-action" type="button" onClick={clearScheduleForm}>
              Cancelar
            </button>
          ) : null}
        </div>

        <div className="field-grid two-columns">
          <label>
            Nome
            <input
              required
              name="scheduleName"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Palmeirinha FM manha"
            />
          </label>
          <label>
            Tipo
            <select name="scheduleKind" value={kind} onChange={(event) => setKind(event.target.value as ScheduleKind)}>
              <option value="power_on_start">Ligar computador e tocar</option>
              <option value="shutdown">Desligar computador</option>
            </select>
          </label>
          <label>
            Computador
            <select name="scheduleDeviceId" value={deviceId} onChange={(event) => setDeviceId(event.target.value)} required>
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
                name="scheduleProfileId"
                value={effectiveProfileId}
                onChange={(event) => setProfileId(event.target.value)}
                required
              >
                <option value="" disabled>
                  Selecione a radio
                </option>
                {allowedProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              {selectedDevice && allowedProfiles.length === 0 ? (
                <p className="field-note tone-warning">
                  Vincule uma radio a este computador na aba Computadores.
                </p>
              ) : null}
            </label>
          ) : null}
          <label>
            Horario
            <input
              required
              type="time"
              name="timeOfDay"
              value={timeOfDay}
              onChange={(event) => setTimeOfDay(event.target.value)}
            />
          </label>
          <label>
            Timezone
            <input
              required
              name="timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </label>
        </div>

        <div className="day-picker" aria-label="Dias da semana">
          {weekDays.map((day) => (
            <label key={day.value} className={daysOfWeek.includes(day.value) ? "active" : ""}>
              <input
                type="checkbox"
                name="daysOfWeek"
                checked={daysOfWeek.includes(day.value)}
                onChange={() => toggleDay(day.value)}
              />
              <span>{day.label}</span>
            </label>
          ))}
        </div>

        <button
          className="small-action form-submit"
          type="submit"
          disabled={creating || devices.length === 0 || (kind === "power_on_start" && !effectiveProfileId)}
        >
          <Plus aria-hidden="true" />
          {creating
            ? editingScheduleId
              ? "Salvando"
              : "Criando"
            : editingScheduleId
              ? "Salvar agendamento"
              : "Criar agendamento"}
        </button>
      </form>

      <div className="wol-grid">
        {schedules.length === 0 ? <p className="empty-state">Nenhum agendamento cadastrado.</p> : null}
        {schedules.map((schedule) => {
          const device = devices.find((item) => item.id === schedule.deviceId);
          const profile = profiles.find((item) => item.id === schedule.profileId);
          const lastRun = runs.find((run) => run.scheduleId === schedule.id);
          return (
            <article className="wol-row" key={schedule.id}>
              <header>
                <strong>{schedule.name}</strong>
                <span className={`status-badge ${schedule.status}`}>
                  {schedule.status === "enabled" ? "Ativo" : "Inativo"}
                </span>
              </header>
              <p className="muted">
                {schedule.kind === "power_on_start" ? "Ligar e tocar" : "Desligar"} -{" "}
                {device?.name ?? schedule.deviceId}
                {profile ? ` - ${profile.name}` : ""} - {schedule.timeOfDay}
              </p>
              <p className="muted">
                {schedule.daysOfWeek
                  .map((day) => weekDays.find((item) => item.value === day)?.label)
                  .filter(Boolean)
                  .join(", ")}
              </p>
              <div className="schedule-meta">
                <span>Proxima: {formatDateTime(schedule.nextRunAt)}</span>
                <span>
                  Ultima: {lastRun ? `${lastRun.status} em ${formatDateTime(lastRun.startedAt)}` : "Nunca"}
                </span>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busyId === schedule.id}
                  onClick={() => startScheduleEdit(schedule)}
                >
                  <Pencil aria-hidden="true" />
                  Editar
                </button>
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
    </div>
  );
}

function GatewaysTab({
  token,
  devices,
  gateways,
  onNotice,
  onRefresh
}: {
  token: string;
  devices: SafeDevice[];
  gateways: SafeWolGateway[];
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
}) {
  const [gatewayName, setGatewayName] = useState("");
  const [generatedGateway, setGeneratedGateway] = useState<{
    gatewayId: string;
    token: string;
  } | null>(null);
  const [creatingGateway, setCreatingGateway] = useState(false);
  const [gatewayDrafts, setGatewayDrafts] = useState<
    Record<string, { name: string; location: string }>
  >({});
  const [savingGatewayId, setSavingGatewayId] = useState<string | null>(null);

  useEffect(() => {
    setGatewayDrafts((current) => {
      const next: Record<string, { name: string; location: string }> = {};
      for (const gateway of gateways) {
        next[gateway.id] = current[gateway.id] ?? {
          name: gateway.name,
          location: gateway.location
        };
      }
      return next;
    });
  }, [gateways]);

  async function submitGateway(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingGateway(true);
    try {
      const gateway = await createWolGateway({
        token,
        name: gatewayName,
        location: "Rede local"
      });
      setGatewayName("");
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

  async function saveGateway(gatewayId: string) {
    const draft = gatewayDrafts[gatewayId];
    if (!draft) {
      return;
    }
    setSavingGatewayId(gatewayId);
    try {
      await updateWolGateway({
        token,
        gatewayId,
        name: draft.name,
        location: draft.location
      });
      onNotice("Gateway atualizado.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel atualizar o gateway.");
    } finally {
      setSavingGatewayId(null);
    }
  }

  return (
    <div className="tab-container">
      <p className="wol-hint">
        Gateways ESP32 enviam Wake on LAN na rede. O local fica no cadastro de cada computador.
      </p>

      <form className="mini-form" onSubmit={submitGateway}>
        <div className="form-heading">
          <strong>Adicionar gateway ESP32</strong>
          <span>Cadastre o hardware; vincule os computadores na aba Computadores.</span>
        </div>

        <div className="field-grid">
          <label>
            Nome
            <input
              name="gatewayName"
              value={gatewayName}
              onChange={(event) => setGatewayName(event.target.value)}
              placeholder="ESP32 Studio 01"
              required
            />
          </label>
        </div>

        <button className="small-action form-submit" type="submit" disabled={creatingGateway}>
          <Plus aria-hidden="true" />
          {creatingGateway ? "Criando" : "Criar gateway"}
        </button>
      </form>

      {generatedGateway ? (
        <div className="token-box token-box-spaced">
          <KeyRound aria-hidden="true" />
          <div>
            <p>Credenciais do ESP32:</p>
            <code>
              WOL_GATEWAY_ID={generatedGateway.gatewayId}
              {"\n"}WOL_GATEWAY_TOKEN={generatedGateway.token}
            </code>
          </div>
        </div>
      ) : null}

      <div className="wol-grid">
        {gateways.length === 0 ? <p className="empty-state">Nenhum gateway cadastrado.</p> : null}
        {gateways.map((gateway) => {
          const isOnline = gateway.status === "online";
          const linkedDevices = devices.filter((device) => device.wolGatewayId === gateway.id);
          const draft = gatewayDrafts[gateway.id] ?? {
            name: gateway.name,
            location: gateway.location
          };
          return (
            <article className="wol-row" key={gateway.id}>
              <header>
                <div className="entity-title">
                  <strong>{gateway.name}</strong>
                  <span
                    className={`status-indicator ${isOnline ? "online" : "offline"}`}
                    title={statusText(gateway.status)}
                  />
                </div>
                <span>{linkedDevices.length} computador(es)</span>
              </header>
              <p className="muted">ID: {gateway.id}</p>
              {linkedDevices.length > 0 ? (
                <div className="linked-device-list">
                  {linkedDevices.map((device) => (
                    <span key={device.id}>
                      {device.name} - {device.location}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">Nenhum computador vinculado a este gateway.</p>
              )}
              <div className="config-subgrid">
                <div className="config-block">
                  <strong>Gateway</strong>
                  <label>
                    Nome
                    <input
                      name={`gateway-name-${gateway.id}`}
                      value={draft.name}
                      onChange={(event) =>
                        setGatewayDrafts((current) => ({
                          ...current,
                          [gateway.id]: { ...draft, name: event.target.value }
                        }))
                      }
                    />
                  </label>
                </div>
              </div>
              <div className="form-actions">
                <button
                  className="small-action"
                  type="button"
                  disabled={savingGatewayId === gateway.id}
                  onClick={() => saveGateway(gateway.id)}
                >
                  <Save aria-hidden="true" />
                  {savingGatewayId === gateway.id ? "Salvando" : "Salvar gateway"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
