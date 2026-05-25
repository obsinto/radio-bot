export const COMMAND_ACTIONS = [
  "open_site",
  "login",
  "reload",
  "screenshot",
  "get_state",
  "click_action",
  "confirm_open_here",
  "play_radio",
  "stop_playback",
  "shutdown",
  "power_on"
] as const;

export type CommandAction = (typeof COMMAND_ACTIONS)[number];

export type CommandStatus =
  | "queued"
  | "sent"
  | "running"
  | "waiting_confirmation"
  | "succeeded"
  | "failed";

export type ScheduleKind = "power_on_start" | "shutdown";

export type ScheduleStatus = "enabled" | "disabled";

export type ScheduleRunStatus = "running" | "succeeded" | "failed";

export type DeviceStatus = "offline" | "online";

export type WolGatewayStatus = "offline" | "online";

export type WolGateway = {
  id: string;
  name: string;
  location: string;
  token: string;
  status: WolGatewayStatus;
  lastSeenAt: string | null;
};

export type SafeWolGateway = Omit<WolGateway, "token">;

export type SiteProfile = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  password: string;
};

export type SafeSiteProfile = Omit<SiteProfile, "password"> & {
  usernameLabel: string;
  hasCredentials: boolean;
};

export type Device = {
  id: string;
  name: string;
  location: string;
  token: string;
  profileIds: string[];
  status: DeviceStatus;
  lastSeenAt: string | null;
  currentProfileId: string | null;
  activeUrl: string | null;
  title: string | null;
  macAddress: string | null;
  broadcastAddress: string | null;
  wolGatewayId: string | null;
};

export type SafeDevice = Omit<Device, "token"> & {
  agentToken: string | null;
};

export type CommandPayload = {
  actionKey?: string;
  [key: string]: unknown;
};

export type CommandRecord = {
  id: string;
  action: CommandAction;
  profileId: string;
  deviceId: string;
  requestedBy: string;
  payload: CommandPayload;
  status: CommandStatus;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  output: Record<string, unknown> | null;
  screenshot: string | null;
};

export type ScheduleRecord = {
  id: string;
  name: string;
  kind: ScheduleKind;
  deviceId: string;
  profileId: string | null;
  timezone: string;
  timeOfDay: string;
  daysOfWeek: number[];
  status: ScheduleStatus;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleRunRecord = {
  id: string;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: ScheduleRunStatus;
  error: string | null;
  commandIds: string[];
};

export type ScheduleInput = {
  name: string;
  kind: ScheduleKind;
  deviceId: string;
  profileId?: string | null;
  timezone: string;
  timeOfDay: string;
  daysOfWeek: number[];
  status?: ScheduleStatus;
};

export type ScheduleUpdate = Partial<ScheduleInput>;

export type CommandRequest = {
  action: CommandAction;
  profileId: string;
  payload?: CommandPayload;
  confirmations?: number;
};

export type DashboardState = {
  adminEmail: string;
  serverTime?: string;
  profiles: SafeSiteProfile[];
  devices: SafeDevice[];
  wolGateways: SafeWolGateway[];
  commands: CommandRecord[];
  schedules: ScheduleRecord[];
  scheduleRuns: ScheduleRunRecord[];
};

export type WolGatewayCommand = {
  id: string;
  deviceId: string;
  deviceName: string;
  macAddress: string;
  broadcastAddress: string | null;
};

export type WolGatewayPollResult = {
  gatewayId: string;
  command: WolGatewayCommand | null;
};

export type ProfileConflict = {
  profileId: string;
  activeDevices: SafeDevice[];
  requiredConfirmations: number;
};

export type ConfirmationPrompt = {
  title: string;
  message: string;
  confirmLabel: string;
  requiredConfirmations: number;
};

export type SitePrompt = {
  type: "open_here";
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
};

export type ApiError = {
  ok: false;
  code: string;
  message: string;
  conflict?: ProfileConflict;
  confirmation?: ConfirmationPrompt;
};

export type ApiOk<T> = {
  ok: true;
  data: T;
};

export type AgentCommand = {
  id: string;
  action: CommandAction;
  profileId: string;
  payload: CommandPayload;
};

export type ServerToAgentMessage =
  | {
      type: "registered";
      deviceId: string;
    }
  | {
      type: "command";
      command: AgentCommand;
      profile: SiteProfile;
    };

export type AgentBrowserState = {
  currentProfileId: string | null;
  activeUrl: string | null;
  title: string | null;
};

export type AgentToServerMessage =
  | {
      type: "heartbeat";
      state?: Partial<AgentBrowserState>;
    }
  | {
      type: "agent_state";
      state: Partial<AgentBrowserState>;
    }
  | {
      type: "command_result";
      commandId: string;
      status: "succeeded" | "failed" | "waiting_confirmation";
      output?: Record<string, unknown>;
      error?: string;
      screenshot?: string;
      state?: Partial<AgentBrowserState>;
    };

export function isCommandAction(value: unknown): value is CommandAction {
  return typeof value === "string" && COMMAND_ACTIONS.includes(value as CommandAction);
}

export function maskUsername(username: string): string {
  if (!username) {
    return "Link direto";
  }

  const [name, domain] = username.split("@");
  if (!domain) {
    return `${name.slice(0, 2)}***`;
  }

  return `${name.slice(0, 2)}***@${domain}`;
}

export function toSafeProfile(profile: SiteProfile): SafeSiteProfile {
  const { password: _password, ...safe } = profile;
  return {
    ...safe,
    usernameLabel: maskUsername(profile.username),
    hasCredentials: Boolean(profile.username && profile.password)
  };
}

export function toSafeDevice(device: Device): SafeDevice {
  const { token: _token, ...safe } = device;
  return {
    ...safe,
    agentToken: device.token || null
  };
}

export function toSafeWolGateway(gateway: WolGateway): SafeWolGateway {
  const { token: _token, ...safe } = gateway;
  return safe;
}
