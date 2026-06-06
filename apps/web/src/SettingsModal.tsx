import { useEffect, useRef, useState } from "react";
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
  Usb,
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
  deleteDevice,
  deleteProfile,
  deleteSchedule,
  deleteWolGateway,
  runScheduleNow,
  updateAdminCredentials,
  updateDevice,
  updateDeviceProfiles,
  updateDeviceWol,
  updateProfile,
  updateSchedule,
  updateWolGateway
} from "./api.js";
import { Esp32Configurator } from "./Esp32Configurator.js";

type ProfileMode = "direct" | "login";
type Tab = "account" | "radios" | "devices" | "schedules" | "gateways";

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
  onRefresh,
  onSession
}: {
  token: string;
  dashboard: DashboardState;
  onClose: () => void;
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
  onSession: (session: { token: string; email: string }) => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("radios");

  const tabs: Array<{
    id: Tab;
    label: string;
    count?: number;
    icon: typeof Radio;
  }> = [
    { id: "account", label: "Acesso", icon: KeyRound },
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
                  {tab.count === undefined ? null : <em>{tab.count}</em>}
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
            {activeTab === "account" ? (
              <AdminAccessTab
                token={token}
                email={dashboard.adminEmail}
                onNotice={onNotice}
                onRefresh={onRefresh}
                onSession={onSession}
              />
            ) : null}
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

function AdminAccessTab({
  token,
  email,
  onNotice,
  onRefresh,
  onSession
}: {
  token: string;
  email: string;
  onNotice: (message: string | null, tone?: "error" | "success") => void;
  onRefresh: () => Promise<void>;
  onSession: (session: { token: string; email: string }) => void;
}) {
  const [adminEmail, setAdminEmail] = useState(email);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAdminEmail(email);
  }, [email]);

  async function submitAccess(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextEmail = adminEmail.trim().toLowerCase();
    const nextPassword = newPassword.length > 0 ? newPassword : undefined;
    if (nextPassword !== undefined && nextPassword !== confirmPassword) {
      onNotice("A confirmacao da nova senha nao confere.");
      return;
    }

    setSaving(true);
    try {
      const session = await updateAdminCredentials({
        token,
        email: nextEmail,
        currentPassword,
        newPassword: nextPassword
      });
      onSession(session);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onNotice("Acesso atualizado.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel atualizar o acesso.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tab-container access-tab">
      <form className="mini-form" onSubmit={submitAccess}>
        <div className="form-heading">
          <div>
            <strong>Email e senha</strong>
            <span>Atualize as credenciais usadas para entrar no painel.</span>
          </div>
        </div>

        <div className="field-grid two-columns">
          <label>
            Email
            <input
              required
              type="email"
              name="adminEmail"
              autoComplete="username"
              value={adminEmail}
              onChange={(event) => setAdminEmail(event.target.value)}
              placeholder="admin@radio.local"
            />
          </label>
          <label>
            Senha atual
            <input
              required
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder="senha atual"
            />
          </label>
          <label>
            Nova senha
            <input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="minimo 8 caracteres"
            />
          </label>
          <label>
            Confirmar nova senha
            <input
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              minLength={8}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="repita a nova senha"
            />
          </label>
        </div>

        <div className="form-actions split-actions">
          <button className="small-action" type="submit" disabled={saving}>
            <Save aria-hidden="true" />
            {saving ? "Salvando" : "Salvar acesso"}
          </button>
        </div>
      </form>
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
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);

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

  async function removeProfile(profile: SafeSiteProfile) {
    const confirmed = window.confirm(
      `Excluir a radio "${profile.name}"?\n\nIsso tambem remove vinculos, comandos e agendamentos relacionados a ela.`
    );
    if (!confirmed) {
      return;
    }

    setDeletingProfileId(profile.id);
    try {
      await deleteProfile({ token, profileId: profile.id });
      if (editingProfileId === profile.id) {
        clearForm();
      }
      setRecentProfileId((current) => (current === profile.id ? null : current));
      onNotice("Radio excluida.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel excluir a radio.");
    } finally {
      setDeletingProfileId(null);
    }
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
                : "Preencha a URL e, se necessario, as credenciais de login."}
            </span>
          </div>
          <button className="ghost-button compact-action" type="button" onClick={clearForm}>
            Limpar
          </button>
        </div>

        {!editingProfileId ? (
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
        ) : null}

        <div className="field-grid two-columns">
          <label>
            Nome
            <input
              required
              name="profileName"
	              value={profileName}
	              onChange={(event) => setProfileName(event.target.value)}
	              placeholder="Nome da radio"
            />
          </label>
          <label>
            URL
            <input
              required
              name="siteUrl"
	              value={siteUrl}
	              onChange={(event) => setSiteUrl(event.target.value)}
	              placeholder="https://..."
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
	              <button
	                className="danger-button"
	                type="button"
	                disabled={deletingProfileId === profile.id}
	                onClick={() => removeProfile(profile)}
	              >
	                <Trash2 aria-hidden="true" />
	                {deletingProfileId === profile.id ? "Excluindo" : "Excluir"}
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
  const [deletingDeviceId, setDeletingDeviceId] = useState<string | null>(null);

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

  async function removeDevice(device: SafeDevice) {
    const onlineWarning = device.status === "online" ? "\n\nO agente conectado sera desconectado." : "";
    const confirmed = window.confirm(
      `Excluir o computador "${device.name}"?${onlineWarning}\n\nIsso tambem remove comandos e agendamentos relacionados a ele.`
    );
    if (!confirmed) {
      return;
    }

    setDeletingDeviceId(device.id);
    try {
      await deleteDevice({ token, deviceId: device.id });
      setDrafts((current) => {
        const next = { ...current };
        delete next[device.id];
        return next;
      });
      setGeneratedToken((current) => (current?.deviceId === device.id ? null : current));
      onNotice("Computador excluido.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel excluir o computador.");
    } finally {
      setDeletingDeviceId(null);
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
	                  <strong>Credenciais do agente</strong>
	                  <div className="token-box inline-token-box">
	                    <KeyRound aria-hidden="true" />
	                    <div>
	                      <p>Use estes dados no instalador deste computador:</p>
	                      <code>
	                        DEVICE_ID={device.id}
	                        {"\n"}DEVICE_TOKEN={device.agentToken ?? "indisponivel"}
	                      </code>
	                      {device.agentToken ? null : (
	                        <p className="field-note compact-note">
	                          Token antigo armazenado apenas como hash. Recrie o computador para visualizar.
	                        </p>
	                      )}
	                    </div>
	                  </div>
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
	                <button
	                  type="button"
	                  className="danger-button"
	                  disabled={deletingDeviceId === device.id}
	                  onClick={() => removeDevice(device)}
	                >
	                  <Trash2 aria-hidden="true" />
	                  {deletingDeviceId === device.id ? "Excluindo" : "Excluir"}
	                </button>
	              </div>
	            </article>
          );
        })}
      </div>
    </div>
  );
}

type RadioMode = "same" | "per_device";

type ScheduleGroup = {
  key: string;
  name: string;
  kind: ScheduleKind;
  timeOfDay: string;
  timezone: string;
  daysOfWeek: number[];
  items: ScheduleRecord[];
};

function scheduleGroupKey(schedule: {
  name: string;
  kind: ScheduleKind;
  timeOfDay: string;
  timezone: string;
  daysOfWeek: number[];
}): string {
  return [
    schedule.name,
    schedule.kind,
    schedule.timeOfDay,
    schedule.timezone,
    [...schedule.daysOfWeek].sort((a, b) => a - b).join(",")
  ].join(" ");
}

function groupSchedules(schedules: ScheduleRecord[]): ScheduleGroup[] {
  const groups = new Map<string, ScheduleGroup>();
  for (const schedule of schedules) {
    const key = scheduleGroupKey(schedule);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(schedule);
    } else {
      groups.set(key, {
        key,
        name: schedule.name,
        kind: schedule.kind,
        timeOfDay: schedule.timeOfDay,
        timezone: schedule.timezone,
        daysOfWeek: schedule.daysOfWeek,
        items: [schedule]
      });
    }
  }
  return [...groups.values()];
}

function Time24Field({
  value,
  onChange
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [rawHour, rawMinute] = (value || "00:00").split(":");
  const hour = (rawHour ?? "00").padStart(2, "0");
  const minute = (rawMinute ?? "00").padStart(2, "0");
  const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
  const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
  return (
    <div className="time24">
      <select aria-label="Hora" value={hour} onChange={(event) => onChange(`${event.target.value}:${minute}`)}>
        {hours.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <span aria-hidden="true">:</span>
      <select aria-label="Minuto" value={minute} onChange={(event) => onChange(`${hour}:${event.target.value}`)}>
        {minutes.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

// Calendario apenas de visualizacao: segunda a domingo.
const calendarDays = [
  { value: 1, label: "Segunda" },
  { value: 2, label: "Terca" },
  { value: 3, label: "Quarta" },
  { value: 4, label: "Quinta" },
  { value: 5, label: "Sexta" },
  { value: 6, label: "Sabado" },
  { value: 0, label: "Domingo" }
];

function WeekCalendar({
  groups,
  devices
}: {
  groups: ScheduleGroup[];
  devices: SafeDevice[];
}) {
  return (
    <div className="week-calendar">
      {calendarDays.map((day) => {
        const events = groups
          .filter((group) => group.daysOfWeek.includes(day.value))
          .sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay));
        return (
          <div className="week-day" key={day.value}>
            <div className="week-day-head">{day.label}</div>
            {events.length === 0 ? <span className="week-day-empty">—</span> : null}
            {events.map((group) => {
              const allDisabled = group.items.every((item) => item.status === "disabled");
              const deviceNames = group.items
                .map((item) => devices.find((device) => device.id === item.deviceId)?.name ?? item.deviceId)
                .join(", ");
              return (
                <div
                  className={`week-event ${group.kind === "shutdown" ? "shutdown" : ""} ${
                    allDisabled ? "disabled" : ""
                  }`}
                  key={group.key}
                  title={deviceNames}
                >
                  <span className="week-event-time">{group.timeOfDay}</span>
                  <span className="week-event-name">{group.name}</span>
                  <span className="week-event-meta">
                    {group.kind === "power_on_start" ? "Ligar e tocar" : "Desligar"} ·{" "}
                    {group.items.length} PC{group.items.length > 1 ? "s" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
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
  const [deviceIds, setDeviceIds] = useState<string[]>(devices[0] ? [devices[0].id] : []);
  const [radioMode, setRadioMode] = useState<RadioMode>("same");
  const [sharedProfileId, setSharedProfileId] = useState("");
  const [perDeviceProfile, setPerDeviceProfile] = useState<Record<string, string>>({});
  const [timeOfDay, setTimeOfDay] = useState("07:00");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [daysOfWeek, setDaysOfWeek] = useState([1, 2, 3, 4, 5]);
  const [creating, setCreating] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingItems, setEditingItems] = useState<Record<string, string>>({});
  const [view, setView] = useState<"list" | "calendar">("list");
  const formRef = useRef<HTMLFormElement>(null);

  const groups = groupSchedules(schedules);
  const selectedDevices = devices.filter((device) => deviceIds.includes(device.id));

  // "Mesma radio para todos": apenas radios vinculadas a TODOS os computadores escolhidos.
  const sharedProfiles =
    selectedDevices.length > 0
      ? profiles.filter((profile) =>
          selectedDevices.every((device) => device.profileIds.includes(profile.id))
        )
      : [];
  const effectiveSharedProfileId = sharedProfiles.some((profile) => profile.id === sharedProfileId)
    ? sharedProfileId
    : sharedProfiles[0]?.id ?? "";

  function profilesForDevice(deviceId: string): SafeSiteProfile[] {
    const device = devices.find((item) => item.id === deviceId);
    return device ? profiles.filter((profile) => device.profileIds.includes(profile.id)) : [];
  }

  function resolvedPerDeviceProfile(deviceId: string): string {
    const allowed = profilesForDevice(deviceId);
    const current = perDeviceProfile[deviceId];
    if (current && allowed.some((profile) => profile.id === current)) {
      return current;
    }
    return allowed[0]?.id ?? "";
  }

  function profileForSubmit(deviceId: string): string | null {
    if (kind !== "power_on_start") {
      return null;
    }
    return radioMode === "same" ? effectiveSharedProfileId || null : resolvedPerDeviceProfile(deviceId) || null;
  }

  function toggleDay(day: number) {
    setDaysOfWeek((current) =>
      current.includes(day)
        ? current.filter((item) => item !== day)
        : [...current, day].sort((a, b) => a - b)
    );
  }

  function toggleDevice(id: string) {
    setDeviceIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  function clearScheduleForm() {
    setEditingKey(null);
    setEditingItems({});
    setName("");
    setKind("power_on_start");
    setDeviceIds(devices[0] ? [devices[0].id] : []);
    setRadioMode("same");
    setSharedProfileId("");
    setPerDeviceProfile({});
    setTimeOfDay("07:00");
    setTimezone("America/Sao_Paulo");
    setDaysOfWeek([1, 2, 3, 4, 5]);
  }

  function startGroupEdit(group: ScheduleGroup) {
    setEditingKey(group.key);
    setName(group.name);
    setKind(group.kind);
    setDeviceIds(group.items.map((item) => item.deviceId));
    setTimeOfDay(group.timeOfDay);
    setTimezone(group.timezone);
    setDaysOfWeek(group.daysOfWeek);

    const idMap: Record<string, string> = {};
    const profileMap: Record<string, string> = {};
    for (const item of group.items) {
      idMap[item.deviceId] = item.id;
      if (item.profileId) {
        profileMap[item.deviceId] = item.profileId;
      }
    }
    setEditingItems(idMap);
    setPerDeviceProfile(profileMap);

    const distinctProfiles = new Set(group.items.map((item) => item.profileId).filter(Boolean));
    if (group.kind === "power_on_start" && distinctProfiles.size <= 1) {
      setRadioMode("same");
      setSharedProfileId((distinctProfiles.values().next().value as string) ?? "");
    } else {
      setRadioMode(group.kind === "power_on_start" ? "per_device" : "same");
      setSharedProfileId("");
    }

    if (view !== "list") {
      setView("list");
    }
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function submitSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deviceIds.length === 0) {
      onNotice("Selecione pelo menos um computador.");
      return;
    }
    setCreating(true);
    try {
      const base = { name, kind, timezone, timeOfDay, daysOfWeek };
      if (editingKey) {
        for (const deviceId of deviceIds) {
          const payload = { ...base, deviceId, profileId: profileForSubmit(deviceId) };
          const existingId = editingItems[deviceId];
          if (existingId) {
            await updateSchedule({ token, scheduleId: existingId, schedule: payload });
          } else {
            await createSchedule({ token, schedule: { ...payload, status: "enabled" } });
          }
        }
        for (const [deviceId, scheduleId] of Object.entries(editingItems)) {
          if (!deviceIds.includes(deviceId)) {
            await deleteSchedule({ token, scheduleId });
          }
        }
        onNotice("Agendamentos atualizados.", "success");
      } else {
        for (const deviceId of deviceIds) {
          await createSchedule({
            token,
            schedule: { ...base, deviceId, profileId: profileForSubmit(deviceId), status: "enabled" }
          });
        }
        onNotice(
          deviceIds.length > 1
            ? `${deviceIds.length} agendamentos criados.`
            : "Agendamento criado.",
          "success"
        );
      }
      clearScheduleForm();
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel salvar o agendamento.");
    } finally {
      setCreating(false);
    }
  }

  async function toggleGroup(group: ScheduleGroup) {
    const allEnabled = group.items.every((item) => item.status === "enabled");
    const status = allEnabled ? "disabled" : "enabled";
    setBusyKey(group.key);
    try {
      for (const item of group.items) {
        await updateSchedule({ token, scheduleId: item.id, schedule: { status } });
      }
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel atualizar o agendamento.");
    } finally {
      setBusyKey(null);
    }
  }

  async function runGroupNow(group: ScheduleGroup) {
    setBusyKey(group.key);
    try {
      for (const item of group.items) {
        await runScheduleNow({ token, scheduleId: item.id });
      }
      onNotice("Agendamento enviado para execucao.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel executar agora.");
    } finally {
      setBusyKey(null);
    }
  }

  async function removeGroup(group: ScheduleGroup) {
    const message =
      group.items.length > 1
        ? `Excluir este agendamento de ${group.items.length} computadores?`
        : "Excluir este agendamento?";
    if (!window.confirm(message)) {
      return;
    }
    setBusyKey(group.key);
    try {
      for (const item of group.items) {
        await deleteSchedule({ token, scheduleId: item.id });
      }
      onNotice("Agendamento removido.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel remover.");
    } finally {
      setBusyKey(null);
    }
  }

  const missingRadioDevices =
    kind === "power_on_start"
      ? selectedDevices.filter((device) => profilesForDevice(device.id).length === 0)
      : [];
  const perDeviceReady =
    kind !== "power_on_start" ||
    (radioMode === "same"
      ? Boolean(effectiveSharedProfileId)
      : deviceIds.every((id) => Boolean(resolvedPerDeviceProfile(id))));
  const canSubmit = !creating && deviceIds.length > 0 && perDeviceReady;

  return (
    <div className="tab-container">
      <form className="mini-form" ref={formRef} onSubmit={submitSchedule}>
        <div className="form-heading">
          <div>
            <strong>{editingKey ? "Editar agendamento" : "Criar agendamento"}</strong>
            <span>
              {editingKey
                ? "Altere computadores, radio e horario desta rotina."
                : "Selecione um ou varios computadores para criar a mesma rotina de uma vez."}
            </span>
          </div>
          {editingKey ? (
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
            Horario
            <Time24Field value={timeOfDay} onChange={setTimeOfDay} />
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

        <div className="form-field-block">
          <span className="block-label">Computadores ({deviceIds.length} selecionados)</span>
          <div className="device-picker" aria-label="Computadores">
            {devices.length === 0 ? (
              <p className="field-note tone-warning">Cadastre um computador na aba Computadores.</p>
            ) : null}
            {devices.map((device) => (
              <label key={device.id} className={deviceIds.includes(device.id) ? "active" : ""}>
                <input
                  type="checkbox"
                  checked={deviceIds.includes(device.id)}
                  onChange={() => toggleDevice(device.id)}
                />
                <span>{device.name}</span>
              </label>
            ))}
          </div>
        </div>

        {kind === "power_on_start" ? (
          <div className="form-field-block">
            <span className="block-label">Radio</span>
            <div className="radio-mode-toggle" role="radiogroup" aria-label="Modo de radio">
              <label className={radioMode === "same" ? "active" : ""}>
                <input
                  type="radio"
                  name="radioMode"
                  checked={radioMode === "same"}
                  onChange={() => setRadioMode("same")}
                />
                <span>Mesma radio para todos</span>
              </label>
              <label className={radioMode === "per_device" ? "active" : ""}>
                <input
                  type="radio"
                  name="radioMode"
                  checked={radioMode === "per_device"}
                  onChange={() => setRadioMode("per_device")}
                />
                <span>Escolher radio por computador</span>
              </label>
            </div>

            {radioMode === "same" ? (
              <label>
                <select
                  value={effectiveSharedProfileId}
                  onChange={(event) => setSharedProfileId(event.target.value)}
                  required
                >
                  <option value="" disabled>
                    Selecione a radio
                  </option>
                  {sharedProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                {selectedDevices.length > 0 && sharedProfiles.length === 0 ? (
                  <p className="field-note tone-warning">
                    Nenhuma radio esta vinculada a todos os computadores selecionados. Use "Escolher radio por
                    computador" ou ajuste os vinculos na aba Computadores.
                  </p>
                ) : null}
              </label>
            ) : (
              <div className="per-device-radios">
                {selectedDevices.map((device) => {
                  const allowed = profilesForDevice(device.id);
                  return (
                    <label key={device.id}>
                      <span className="per-device-name">{device.name}</span>
                      {allowed.length === 0 ? (
                        <span className="field-note tone-warning">Sem radio vinculada.</span>
                      ) : (
                        <select
                          value={resolvedPerDeviceProfile(device.id)}
                          onChange={(event) =>
                            setPerDeviceProfile((current) => ({
                              ...current,
                              [device.id]: event.target.value
                            }))
                          }
                        >
                          {allowed.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </label>
                  );
                })}
              </div>
            )}

            {radioMode === "per_device" && missingRadioDevices.length > 0 ? (
              <p className="field-note tone-warning">
                Sem radio vinculada: {missingRadioDevices.map((device) => device.name).join(", ")}.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="form-field-block">
          <span className="block-label">Dias da semana</span>
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
        </div>

        <button className="small-action form-submit" type="submit" disabled={!canSubmit}>
          <Plus aria-hidden="true" />
          {creating
            ? editingKey
              ? "Salvando"
              : "Criando"
            : editingKey
              ? "Salvar agendamento"
              : deviceIds.length > 1
                ? `Criar para ${deviceIds.length} computadores`
                : "Criar agendamento"}
        </button>
      </form>

      <div className="schedule-view-toggle">
        <button
          type="button"
          className={view === "list" ? "active" : ""}
          onClick={() => setView("list")}
        >
          Lista
        </button>
        <button
          type="button"
          className={view === "calendar" ? "active" : ""}
          onClick={() => setView("calendar")}
        >
          Calendario
        </button>
      </div>

      {view === "calendar" ? (
        groups.length === 0 ? (
          <p className="empty-state">Nenhum agendamento cadastrado.</p>
        ) : (
          <WeekCalendar groups={groups} devices={devices} />
        )
      ) : (
      <div className="wol-grid">
        {groups.length === 0 ? <p className="empty-state">Nenhum agendamento cadastrado.</p> : null}
        {groups.map((group) => {
          const allEnabled = group.items.every((item) => item.status === "enabled");
          const anyEnabled = group.items.some((item) => item.status === "enabled");
          const statusLabel = allEnabled ? "Ativo" : anyEnabled ? "Parcial" : "Inativo";
          const statusClass = allEnabled ? "enabled" : anyEnabled ? "partial" : "disabled";
          const nextRunAt = group.items
            .map((item) => item.nextRunAt)
            .filter((value): value is string => Boolean(value))
            .sort()[0] ?? null;
          const lastRun = group.items
            .map((item) => runs.find((run) => run.scheduleId === item.id))
            .filter((run): run is DashboardState["scheduleRuns"][number] => Boolean(run))
            .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
          return (
            <article className="wol-row" key={group.key}>
              <header>
                <strong>{group.name}</strong>
                <span className={`status-badge ${statusClass}`}>{statusLabel}</span>
              </header>
              <p className="muted">
                {group.kind === "power_on_start" ? "Ligar e tocar" : "Desligar"} - {group.timeOfDay} -{" "}
                {group.items.length} computador{group.items.length > 1 ? "es" : ""}
              </p>
              <ul className="schedule-device-list">
                {group.items.map((item) => {
                  const device = devices.find((entry) => entry.id === item.deviceId);
                  const profile = profiles.find((entry) => entry.id === item.profileId);
                  return (
                    <li key={item.id}>
                      <span>{device?.name ?? item.deviceId}</span>
                      {profile ? <span className="muted"> - {profile.name}</span> : null}
                      {item.status === "disabled" ? <span className="muted"> (inativo)</span> : null}
                    </li>
                  );
                })}
              </ul>
              <p className="muted">
                {group.daysOfWeek
                  .map((day) => weekDays.find((item) => item.value === day)?.label)
                  .filter(Boolean)
                  .join(", ")}
              </p>
              <div className="schedule-meta">
                <span>Proxima: {formatDateTime(nextRunAt)}</span>
                <span>
                  Ultima: {lastRun ? `${lastRun.status} em ${formatDateTime(lastRun.startedAt)}` : "Nunca"}
                </span>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busyKey === group.key}
                  onClick={() => startGroupEdit(group)}
                >
                  <Pencil aria-hidden="true" />
                  Editar
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busyKey === group.key}
                  onClick={() => toggleGroup(group)}
                >
                  {allEnabled ? "Desativar" : "Ativar"}
                </button>
                <button
                  type="button"
                  className="small-action"
                  disabled={busyKey === group.key}
                  onClick={() => runGroupNow(group)}
                >
                  <Play aria-hidden="true" />
                  Executar agora
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={busyKey === group.key}
                  onClick={() => removeGroup(group)}
                >
                  <Trash2 aria-hidden="true" />
                  Excluir
                </button>
              </div>
            </article>
          );
        })}
      </div>
      )}
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
  const [deletingGatewayId, setDeletingGatewayId] = useState<string | null>(null);
  const [showConfigurator, setShowConfigurator] = useState(false);

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

  async function removeGateway(gateway: SafeWolGateway) {
    const linkedDevices = devices.filter((device) => device.wolGatewayId === gateway.id);
    const linkedWarning =
      linkedDevices.length > 0
        ? `\n\nEle sera desvinculado de ${linkedDevices.length} computador(es).`
        : "";
    const confirmed = window.confirm(`Excluir o gateway "${gateway.name}"?${linkedWarning}`);
    if (!confirmed) {
      return;
    }

    setDeletingGatewayId(gateway.id);
    try {
      await deleteWolGateway({ token, gatewayId: gateway.id });
      setGatewayDrafts((current) => {
        const next = { ...current };
        delete next[gateway.id];
        return next;
      });
      setGeneratedGateway((current) => (current?.gatewayId === gateway.id ? null : current));
      onNotice("Gateway excluido.", "success");
      await onRefresh();
    } catch (error) {
      onNotice((error as ApiError).message ?? "Nao foi possivel excluir o gateway.");
    } finally {
      setDeletingGatewayId(null);
    }
  }

  return (
    <div className="tab-container">
      <p className="wol-hint">
        Gateways ESP32 enviam Wake on LAN na rede. O local fica no cadastro de cada computador.
      </p>

      <div className="form-actions">
        <button
          className="small-action"
          type="button"
          onClick={() => setShowConfigurator((current) => !current)}
        >
          <Usb aria-hidden="true" />
          {showConfigurator ? "Fechar configurador" : "Configurar ESP32 via USB"}
        </button>
      </div>

      {showConfigurator ? (
        <Esp32Configurator
          sessionToken={token}
          gateways={gateways}
          onNotice={onNotice}
          onRefresh={onRefresh}
        />
      ) : null}

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
	                <button
	                  className="danger-button"
	                  type="button"
	                  disabled={deletingGatewayId === gateway.id}
	                  onClick={() => removeGateway(gateway)}
	                >
	                  <Trash2 aria-hidden="true" />
	                  {deletingGatewayId === gateway.id ? "Excluindo" : "Excluir"}
	                </button>
	              </div>
	            </article>
          );
        })}
      </div>
    </div>
  );
}
