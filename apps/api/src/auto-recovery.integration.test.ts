import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket, { type RawData } from "ws";
import type { DashboardState } from "@radio-bot/shared";
import type { AppConfig } from "./config.js";
import { createServer } from "./server.js";

const config: AppConfig = {
  port: 0,
  host: "127.0.0.1",
  appUrl: "http://localhost",
  jwtSecret: "integration-test-secret",
  adminEmail: "admin@example.com",
  adminPassword: "test-password",
  databaseUrl: null,
  encryptionKey: "integration-test-key",
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
      token: "device-token",
      profileIds: ["radio-a"],
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
  ],
  autoRecover: {
    enabled: true,
    graceMs: 20,
    backoffMs: 100,
    intentionalWindowMs: 1000,
    scanIntervalMs: 20
  }
};

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Tempo limite aguardando condicao do teste.");
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Tempo limite aguardando mensagem WebSocket."));
    }, 2000);
    const onMessage = (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function startTestServer() {
  const server = await createServer(config);
  try {
    await server.listen({
      host: "127.0.0.1",
      port: 0
    });
  } catch (error) {
    await server.close();
    throw error;
  }
  const address = server.server.address() as AddressInfo;
  const login = await server.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: config.adminEmail,
      password: config.adminPassword
    }
  });
  const token = login.json().data.token as string;
  return {
    server,
    token,
    wsUrl: `ws://127.0.0.1:${address.port}/agent?deviceId=pc-a&token=device-token`
  };
}

async function dashboardState(
  server: Awaited<ReturnType<typeof createServer>>,
  token: string
): Promise<DashboardState> {
  const response = await server.inject({
    method: "GET",
    url: "/api/state",
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  assert.equal(response.statusCode, 200);
  return response.json().data as DashboardState;
}

test("abrupt agent loss creates and delivers a WOL command", async () => {
  const { server, token, wsUrl } = await startTestServer();
  const socket = new WebSocket(wsUrl);

  try {
    const registered = waitForMessage(socket, (message) => message.type === "registered");
    await once(socket, "open");
    await registered;
    socket.send(
      JSON.stringify({
        type: "heartbeat",
        state: {
          currentProfileId: "radio-a",
          activeUrl: "https://radio-a.example",
          title: "Radio A"
        }
      })
    );
    await waitFor(async () => {
      const state = await dashboardState(server, token);
      return state.devices[0]?.status === "online";
    });

    socket.close();
    await once(socket, "close");

    let wolCommand: Record<string, unknown> | null = null;
    await waitFor(async () => {
      const poll = await server.inject({
        method: "GET",
        url: "/wol-gateway/poll?gatewayId=gateway-a",
        headers: {
          authorization: "Bearer gateway-token"
        }
      });
      wolCommand = poll.json().data.command as Record<string, unknown> | null;
      return wolCommand !== null;
    });

    const deliveredCommand = wolCommand as Record<string, unknown> | null;
    assert.ok(deliveredCommand);
    assert.equal(deliveredCommand.deviceId, "pc-a");
    assert.equal(deliveredCommand.macAddress, "AA:BB:CC:DD:EE:FF");
  } finally {
    socket.terminate();
    await server.close();
  }
});

test("confirmed panel shutdown keeps the computer off", async () => {
  const { server, token, wsUrl } = await startTestServer();
  const socket = new WebSocket(wsUrl);

  try {
    const registered = waitForMessage(socket, (message) => message.type === "registered");
    await once(socket, "open");
    await registered;
    socket.send(
      JSON.stringify({
        type: "heartbeat",
        state: {
          currentProfileId: "radio-a",
          activeUrl: "https://radio-a.example",
          title: "Radio A"
        }
      })
    );

    const commandMessage = waitForMessage(
      socket,
      (message) =>
        message.type === "command" &&
        (message.command as Record<string, unknown>)?.action === "shutdown"
    );
    const response = await server.inject({
      method: "POST",
      url: "/api/devices/pc-a/commands",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        action: "shutdown"
      }
    });
    assert.equal(response.statusCode, 200);

    const message = await commandMessage;
    const command = message.command as Record<string, unknown>;
    socket.send(
      JSON.stringify({
        type: "command_result",
        commandId: command.id,
        status: "succeeded",
        output: {
          dryRun: false
        },
        state: {
          currentProfileId: "radio-a",
          activeUrl: "https://radio-a.example",
          title: "Radio A"
        }
      })
    );
    await waitFor(async () => {
      const state = await dashboardState(server, token);
      return state.commands.some(
        (candidate) =>
          candidate.id === command.id && candidate.status === "succeeded"
      );
    });

    socket.close();
    await once(socket, "close");
    await new Promise((resolve) => setTimeout(resolve, 150));

    const state = await dashboardState(server, token);
    assert.equal(
      state.commands.some(
        (candidate) =>
          candidate.deviceId === "pc-a" && candidate.action === "power_on"
      ),
      false
    );
  } finally {
    socket.terminate();
    await server.close();
  }
});
