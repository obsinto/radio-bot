import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "./config.js";
import { decideAutoRecovery } from "./auto-recovery.js";
import { selectResumeProfile } from "./resume-radio.js";
import { AppStore } from "./store.js";

const config: AppConfig = {
  port: 3000,
  host: "127.0.0.1",
  appUrl: "http://localhost",
  jwtSecret: "test",
  adminEmail: "admin@example.com",
  adminPassword: "test",
  databaseUrl: null,
  encryptionKey: "test",
  profiles: [
    {
      id: "radio-a",
      name: "Radio A",
      siteUrl: "https://radio-a.example",
      username: "",
      password: ""
    }
  ],
  devices: [
    {
      id: "pc-a",
      name: "PC A",
      location: "Studio",
      token: "token",
      profileIds: ["radio-a"]
    }
  ],
  wolGateways: [],
  autoRecover: {
    enabled: true,
    graceMs: 90000,
    backoffMs: 300000,
    intentionalWindowMs: 900000
  }
};

test("falls back to the latest successful radio command", () => {
  const store = new AppStore(config);
  const command = store.createCommand({
    action: "play_radio",
    profileId: "radio-a",
    deviceId: "pc-a",
    requestedBy: "test"
  });
  store.completeCommand(command.id, {
    status: "succeeded"
  });

  assert.deepEqual(
    selectResumeProfile({
      allowedProfileIds: ["radio-a"],
      currentProfileId: null,
      commands: store.listRecentCommands()
    }),
    {
      profileId: "radio-a",
      source: "recent_command"
    }
  );
});

test("prefers the current device profile over command history", () => {
  const store = new AppStore({
    ...config,
    profiles: [
      ...config.profiles,
      {
        id: "radio-b",
        name: "Radio B",
        siteUrl: "https://radio-b.example",
        username: "",
        password: ""
      }
    ],
    devices: [
      {
        ...config.devices[0],
        profileIds: ["radio-a", "radio-b"]
      }
    ]
  });
  const command = store.createCommand({
    action: "play_radio",
    profileId: "radio-a",
    deviceId: "pc-a",
    requestedBy: "test"
  });
  store.completeCommand(command.id, {
    status: "succeeded"
  });

  assert.deepEqual(
    selectResumeProfile({
      allowedProfileIds: ["radio-a", "radio-b"],
      currentProfileId: "radio-b",
      commands: store.listRecentCommandsForDevice("pc-a")
    }),
    {
      profileId: "radio-b",
      source: "device_state"
    }
  );
});

test("fails interrupted agent commands without touching queued or WOL commands", () => {
  const store = new AppStore(config);
  const interrupted = store.createCommand({
    action: "open_site",
    profileId: "radio-a",
    deviceId: "pc-a",
    requestedBy: "test"
  });
  const queued = store.createCommand({
    action: "play_radio",
    profileId: "radio-a",
    deviceId: "pc-a",
    requestedBy: "test"
  });
  const wol = store.createCommand({
    action: "power_on",
    profileId: "radio-a",
    deviceId: "pc-a",
    requestedBy: "test"
  });
  store.markCommandSent(interrupted.id);
  store.markCommandSent(wol.id);

  assert.equal(store.failInterruptedAgentCommands("pc-a"), 1);

  const commands = new Map(store.listRecentCommands().map((command) => [command.id, command]));
  assert.equal(commands.get(interrupted.id)?.status, "failed");
  assert.equal(commands.get(queued.id)?.status, "queued");
  assert.equal(commands.get(wol.id)?.status, "sent");
});

test("redelivers a WOL command when the gateway confirmation lease expires", () => {
  const store = new AppStore({
    ...config,
    devices: [
      {
        ...config.devices[0],
        macAddress: "AA:BB:CC:DD:EE:FF",
        broadcastAddress: "192.168.1.255",
        wolGatewayId: "gateway-a"
      }
    ],
    wolGateways: [
      {
        id: "gateway-a",
        name: "Gateway A",
        location: "Studio",
        token: "gateway-token"
      }
    ]
  });
  const command = store.createCommand({
    action: "power_on",
    profileId: "radio-a",
    deviceId: "pc-a",
    requestedBy: "test"
  });

  assert.equal(store.reserveWolCommand("gateway-a")?.id, command.id);
  assert.equal(store.reserveWolCommand("gateway-a"), null);

  const sentCommand = store
    .listRecentCommandsForDevice("pc-a")
    .find((candidate) => candidate.id === command.id);
  assert.ok(sentCommand);
  sentCommand.updatedAt = new Date(Date.now() - 31_000).toISOString();

  assert.equal(store.reserveWolCommand("gateway-a")?.id, command.id);
});

test("preserves the last heartbeat and exposes an abrupt shutdown to WOL recovery", () => {
  const store = new AppStore({
    ...config,
    devices: [
      {
        ...config.devices[0],
        macAddress: "AA:BB:CC:DD:EE:FF",
        broadcastAddress: "192.168.1.255",
        wolGatewayId: "gateway-a"
      }
    ],
    wolGateways: [
      {
        id: "gateway-a",
        name: "Gateway A",
        location: "Studio",
        token: "gateway-token"
      }
    ]
  });
  store.markDeviceOnline("pc-a");
  store.updateDeviceState("pc-a", {
    currentProfileId: "radio-a"
  });
  const lastHeartbeat = store.getDevice("pc-a")?.lastSeenAt;
  assert.ok(lastHeartbeat);

  store.markDeviceOffline("pc-a");
  const offlineDevice = store.getSafeDevice("pc-a");
  assert.ok(offlineDevice);
  assert.equal(offlineDevice.lastSeenAt, lastHeartbeat);

  assert.deepEqual(
    decideAutoRecovery({
      device: {
        ...offlineDevice,
        lastSeenAt: new Date(Date.now() - 91_000).toISOString()
      },
      powerCommands: [],
      policy: config.autoRecover
    }),
    { enqueue: true }
  );
});

test("consumes shutdown authorization only after its requested delay", () => {
  const store = new AppStore(config);
  const shutdown = store.createCommand({
    action: "shutdown",
    profileId: null,
    deviceId: "pc-a",
    requestedBy: "admin@example.com",
    payload: {
      delaySeconds: 60,
      intentionalShutdown: true,
      shutdownSource: "panel"
    }
  });
  store.completeCommand(shutdown.id, {
    status: "succeeded"
  });

  assert.equal(store.consumeShutdownAuthorizations("pc-a"), 0);

  const storedShutdown = store
    .listRecentCommandsForDevice("pc-a")
    .find((command) => command.id === shutdown.id);
  assert.ok(storedShutdown);
  storedShutdown.updatedAt = new Date(Date.now() - 3_600_000).toISOString();
  assert.equal(
    store
      .listRecentPowerCommandsForDevice(
        "pc-a",
        new Date(Date.now() - 900_000).toISOString()
      )
      .some((command) => command.id === shutdown.id),
    true
  );

  assert.equal(store.consumeShutdownAuthorizations("pc-a"), 1);
  assert.ok(storedShutdown.payload.shutdownAuthorizationConsumedAt);
});
