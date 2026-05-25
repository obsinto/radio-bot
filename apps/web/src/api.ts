import type {
  ApiError,
  CommandAction,
  CommandPayload,
  CommandRecord,
  DashboardState,
  SafeDevice,
  SafeSiteProfile,
  SafeWolGateway,
  ScheduleInput,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleUpdate
} from "@radio-bot/shared";

export const API_URL =
  import.meta.env.VITE_API_URL ??
  `${window.location.protocol}//${window.location.hostname}:3000`;

type LoginResult = {
  token: string;
  email: string;
};

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) {
    throw data as ApiError;
  }
  return data.data as T;
}

function requireGatewayToken(gateway: SafeWolGateway & { token?: string }): SafeWolGateway & { token: string } {
  if (!gateway.token) {
    throw {
      ok: false,
      code: "MISSING_WOL_GATEWAY_TOKEN",
      message: "A API nao retornou o token do ESP32. Recrie o gateway usando o backend real."
    } satisfies ApiError;
  }
  return gateway as SafeWolGateway & { token: string };
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email,
      password
    })
  });

  return parseResponse<LoginResult>(response);
}

export async function getState(token: string): Promise<DashboardState> {
  const response = await fetch(`${API_URL}/api/state`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  return parseResponse<DashboardState>(response);
}

export async function updateAdminCredentials(input: {
  token: string;
  email: string;
  currentPassword: string;
  newPassword?: string;
}): Promise<LoginResult> {
  const response = await fetch(`${API_URL}/api/admin-credentials`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      email: input.email,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword
    })
  });

  return parseResponse<LoginResult>(response);
}

export async function sendCommand(input: {
  token: string;
  deviceId: string;
  profileId: string;
  action: CommandAction;
  payload?: CommandPayload;
  confirmations?: number;
}): Promise<CommandRecord> {
  const response = await fetch(`${API_URL}/api/devices/${input.deviceId}/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: input.action,
      profileId: input.profileId,
      payload: input.payload,
      confirmations: input.confirmations
    })
  });

  return parseResponse<CommandRecord>(response);
}

export async function createProfile(input: {
  token: string;
  name: string;
  siteUrl: string;
  username: string;
  password: string;
}): Promise<SafeSiteProfile> {
  const response = await fetch(`${API_URL}/api/profiles`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      siteUrl: input.siteUrl,
      username: input.username,
      password: input.password
    })
  });

  return parseResponse<SafeSiteProfile>(response);
}

export async function updateProfile(input: {
  token: string;
  profileId: string;
  name: string;
  siteUrl: string;
}): Promise<SafeSiteProfile> {
  const response = await fetch(`${API_URL}/api/profiles/${input.profileId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      siteUrl: input.siteUrl
    })
  });

  return parseResponse<SafeSiteProfile>(response);
}

export async function deleteProfile(input: {
  token: string;
  profileId: string;
}): Promise<{ id: string }> {
  const response = await fetch(`${API_URL}/api/profiles/${input.profileId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${input.token}`
    }
  });

  return parseResponse<{ id: string }>(response);
}

export async function createDevice(input: {
  token: string;
  name: string;
  location: string;
  profileIds: string[];
}): Promise<SafeDevice & { token: string }> {
  const response = await fetch(`${API_URL}/api/devices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      location: input.location,
      profileIds: input.profileIds
    })
  });

  return parseResponse<SafeDevice & { token: string }>(response);
}

export async function updateDevice(input: {
  token: string;
  deviceId: string;
  name: string;
  location: string;
}): Promise<SafeDevice> {
  const response = await fetch(`${API_URL}/api/devices/${input.deviceId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      location: input.location
    })
  });

  return parseResponse<SafeDevice>(response);
}

export async function deleteDevice(input: {
  token: string;
  deviceId: string;
}): Promise<{ id: string }> {
  const response = await fetch(`${API_URL}/api/devices/${input.deviceId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${input.token}`
    }
  });

  return parseResponse<{ id: string }>(response);
}

export async function updateDeviceProfiles(input: {
  token: string;
  deviceId: string;
  profileIds: string[];
}): Promise<{
  id: string;
  profileIds: string[];
}> {
  const response = await fetch(`${API_URL}/api/devices/${input.deviceId}/profiles`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      profileIds: input.profileIds
    })
  });

  return parseResponse<{
    id: string;
    profileIds: string[];
  }>(response);
}

export async function updateDeviceWol(input: {
  token: string;
  deviceId: string;
  macAddress: string;
  broadcastAddress: string;
  wolGatewayId: string;
}): Promise<{
  id: string;
  macAddress: string | null;
  broadcastAddress: string | null;
  wolGatewayId: string | null;
}> {
  const response = await fetch(`${API_URL}/api/devices/${input.deviceId}/wol`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      macAddress: input.macAddress,
      broadcastAddress: input.broadcastAddress,
      wolGatewayId: input.wolGatewayId
    })
  });

  return parseResponse<{
    id: string;
    macAddress: string | null;
    broadcastAddress: string | null;
    wolGatewayId: string | null;
  }>(response);
}

export async function createWolGateway(input: {
  token: string;
  name: string;
  location: string;
}): Promise<SafeWolGateway & { token: string }> {
  const response = await fetch(`${API_URL}/api/wol-gateways`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      location: input.location
    })
  });

  return requireGatewayToken(await parseResponse<SafeWolGateway & { token?: string }>(response));
}

export async function rotateWolGatewayToken(input: {
  token: string;
  gatewayId: string;
}): Promise<SafeWolGateway & { token: string }> {
  const response = await fetch(`${API_URL}/api/wol-gateways/${input.gatewayId}/rotate-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`
    }
  });

  return requireGatewayToken(await parseResponse<SafeWolGateway & { token?: string }>(response));
}

export async function updateWolGateway(input: {
  token: string;
  gatewayId: string;
  name: string;
  location: string;
}): Promise<SafeWolGateway> {
  const response = await fetch(`${API_URL}/api/wol-gateways/${input.gatewayId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      location: input.location
    })
  });

  return parseResponse<SafeWolGateway>(response);
}

export async function deleteWolGateway(input: {
  token: string;
  gatewayId: string;
}): Promise<{ id: string }> {
  const response = await fetch(`${API_URL}/api/wol-gateways/${input.gatewayId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${input.token}`
    }
  });

  return parseResponse<{ id: string }>(response);
}

export async function createSchedule(input: {
  token: string;
  schedule: ScheduleInput;
}): Promise<ScheduleRecord> {
  const response = await fetch(`${API_URL}/api/schedules`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input.schedule)
  });

  return parseResponse<ScheduleRecord>(response);
}

export async function updateSchedule(input: {
  token: string;
  scheduleId: string;
  schedule: ScheduleUpdate;
}): Promise<ScheduleRecord> {
  const response = await fetch(`${API_URL}/api/schedules/${input.scheduleId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input.schedule)
  });

  return parseResponse<ScheduleRecord>(response);
}

export async function deleteSchedule(input: {
  token: string;
  scheduleId: string;
}): Promise<{ id: string }> {
  const response = await fetch(`${API_URL}/api/schedules/${input.scheduleId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${input.token}`
    }
  });

  return parseResponse<{ id: string }>(response);
}

export async function runScheduleNow(input: {
  token: string;
  scheduleId: string;
}): Promise<ScheduleRunRecord> {
  const response = await fetch(`${API_URL}/api/schedules/${input.scheduleId}/run-now`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`
    }
  });

  return parseResponse<ScheduleRunRecord>(response);
}
