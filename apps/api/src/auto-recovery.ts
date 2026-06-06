import type { CommandRecord, SafeDevice } from "@radio-bot/shared";

export type AutoRecoveryPolicy = {
  graceMs: number;
  backoffMs: number;
  intentionalWindowMs: number;
};

export type AutoRecoveryDecision =
  | { enqueue: true }
  | {
      enqueue: false;
      reason:
        | "device_online"
        | "wol_not_configured"
        | "offline_grace_period"
        | "authorized_shutdown"
        | "power_on_pending"
        | "power_on_backoff";
    };

export function authorizedShutdownPayload(
  source: "panel" | "scheduler",
  payload: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...payload,
    intentionalShutdown: true,
    shutdownSource: source
  };
}

function isAuthorizedShutdown(command: CommandRecord): boolean {
  return (
    command.action === "shutdown" &&
    command.payload.intentionalShutdown === true &&
    (command.payload.shutdownSource === "panel" ||
      command.payload.shutdownSource === "scheduler") &&
    !command.payload.shutdownAuthorizationConsumedAt &&
    command.status === "succeeded"
  );
}

export function decideAutoRecovery(input: {
  device: SafeDevice;
  powerCommands: CommandRecord[];
  policy: AutoRecoveryPolicy;
  now?: number;
}): AutoRecoveryDecision {
  const now = input.now ?? Date.now();
  const { device, policy } = input;

  if (device.status !== "offline") {
    return { enqueue: false, reason: "device_online" };
  }
  if (!device.macAddress || !device.wolGatewayId) {
    return { enqueue: false, reason: "wol_not_configured" };
  }

  const offlineAt = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : Number.NaN;
  if (!Number.isFinite(offlineAt) || now - offlineAt < policy.graceMs) {
    return { enqueue: false, reason: "offline_grace_period" };
  }

  const authorizedShutdown = input.powerCommands.some(
    (command) =>
      isAuthorizedShutdown(command) &&
      Math.abs(new Date(command.updatedAt).getTime() - offlineAt) <=
        policy.intentionalWindowMs
  );
  if (authorizedShutdown) {
    return { enqueue: false, reason: "authorized_shutdown" };
  }

  const pendingPowerOn = input.powerCommands.some(
    (command) =>
      command.action === "power_on" &&
      (command.status === "queued" ||
        command.status === "sent" ||
        command.status === "running")
  );
  if (pendingPowerOn) {
    return { enqueue: false, reason: "power_on_pending" };
  }

  const recentPowerOn = input.powerCommands.some(
    (command) =>
      command.action === "power_on" &&
      now - new Date(command.updatedAt).getTime() <= policy.backoffMs
  );
  if (recentPowerOn) {
    return { enqueue: false, reason: "power_on_backoff" };
  }

  return { enqueue: true };
}
