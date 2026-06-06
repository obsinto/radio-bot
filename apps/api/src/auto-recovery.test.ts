import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRecord, SafeDevice } from "@radio-bot/shared";
import {
  authorizedShutdownPayload,
  decideAutoRecovery
} from "./auto-recovery.js";

const now = Date.parse("2026-06-06T16:00:00.000Z");
const policy = {
  graceMs: 90_000,
  backoffMs: 300_000,
  intentionalWindowMs: 900_000
};
const device: SafeDevice = {
  id: "pc-a",
  name: "PC A",
  location: "Studio",
  agentToken: null,
  profileIds: ["radio-a"],
  status: "offline",
  lastSeenAt: new Date(now - 120_000).toISOString(),
  currentProfileId: "radio-a",
  activeUrl: null,
  title: null,
  macAddress: "AA:BB:CC:DD:EE:FF",
  broadcastAddress: "192.168.1.255",
  wolGatewayId: "gateway-a"
};

function command(
  action: CommandRecord["action"],
  status: CommandRecord["status"],
  input: Partial<CommandRecord> = {}
): CommandRecord {
  return {
    id: `${action}-${status}`,
    action,
    profileId: "radio-a",
    deviceId: "pc-a",
    requestedBy: "test",
    payload: {},
    status,
    createdAt: new Date(now - 120_000).toISOString(),
    updatedAt: new Date(now - 120_000).toISOString(),
    error: null,
    output: null,
    screenshot: null,
    ...input
  };
}

test("enqueues WOL after an abrupt shutdown", () => {
  assert.deepEqual(
    decideAutoRecovery({
      device: {
        ...device,
        currentProfileId: null
      },
      powerCommands: [],
      policy,
      now
    }),
    { enqueue: true }
  );
});

test("marks only panel and scheduler shutdown payloads as authorized", () => {
  assert.deepEqual(
    authorizedShutdownPayload("panel", {
      delaySeconds: 60,
      intentionalShutdown: false,
      shutdownSource: "client"
    }),
    {
      delaySeconds: 60,
      intentionalShutdown: true,
      shutdownSource: "panel"
    }
  );
  assert.equal(authorizedShutdownPayload("scheduler").shutdownSource, "scheduler");
});

test("suppresses WOL only for a marked panel or scheduler shutdown", () => {
  const panelShutdown = command("shutdown", "succeeded", {
    payload: {
      intentionalShutdown: true,
      shutdownSource: "panel"
    }
  });

  assert.deepEqual(
    decideAutoRecovery({
      device,
      powerCommands: [panelShutdown],
      policy,
      now
    }),
    { enqueue: false, reason: "authorized_shutdown" }
  );

  assert.deepEqual(
    decideAutoRecovery({
      device,
      powerCommands: [
        {
          ...panelShutdown,
          payload: {}
        }
      ],
      policy,
      now
    }),
    { enqueue: true }
  );
});

test("keeps an authorized shutdown off until the computer reconnects", () => {
  const shutdownAt = now - 3_600_000;
  const intentionallyOfflineDevice = {
    ...device,
    lastSeenAt: new Date(shutdownAt + 60_000).toISOString()
  };
  const panelShutdown = command("shutdown", "succeeded", {
    payload: {
      intentionalShutdown: true,
      shutdownSource: "panel"
    },
    createdAt: new Date(shutdownAt).toISOString(),
    updatedAt: new Date(shutdownAt).toISOString()
  });

  assert.deepEqual(
    decideAutoRecovery({
      device: intentionallyOfflineDevice,
      powerCommands: [panelShutdown],
      policy,
      now
    }),
    { enqueue: false, reason: "authorized_shutdown" }
  );
});

test("a consumed, failed, or unconfirmed shutdown does not suppress WOL", () => {
  for (const shutdown of [
    command("shutdown", "succeeded", {
      payload: {
        intentionalShutdown: true,
        shutdownSource: "scheduler",
        shutdownAuthorizationConsumedAt: new Date(now - 30_000).toISOString()
      }
    }),
    command("shutdown", "failed", {
      payload: {
        intentionalShutdown: true,
        shutdownSource: "scheduler"
      }
    }),
    command("shutdown", "sent", {
      payload: {
        intentionalShutdown: true,
        shutdownSource: "panel"
      }
    })
  ]) {
    assert.deepEqual(
      decideAutoRecovery({
        device,
        powerCommands: [shutdown],
        policy,
        now
      }),
      { enqueue: true }
    );
  }
});

test("keeps one pending WOL command and retries after completed-command backoff", () => {
  assert.deepEqual(
    decideAutoRecovery({
      device,
      powerCommands: [command("power_on", "sent")],
      policy,
      now
    }),
    { enqueue: false, reason: "power_on_pending" }
  );

  assert.deepEqual(
    decideAutoRecovery({
      device,
      powerCommands: [
        command("power_on", "succeeded", {
          updatedAt: new Date(now - policy.backoffMs - 1).toISOString()
        })
      ],
      policy,
      now
    }),
    { enqueue: true }
  );
});
