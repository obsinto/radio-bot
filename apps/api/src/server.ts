import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  type AgentToServerMessage,
  type ApiError,
  type CommandRequest,
  isCommandAction,
  type ServerToAgentMessage
} from "@radio-bot/shared";
import { createSessionToken, verifySessionToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import { AppStore } from "./store.js";
import { PostgresStore } from "./postgres-store.js";

type AgentConnection = {
  deviceId: string;
  socket: WebSocket;
};

function getBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

function sendAgentMessage(socket: WebSocket, message: ServerToAgentMessage): void {
  socket.send(JSON.stringify(message));
}

function parseAgentMessage(raw: Buffer): AgentToServerMessage | null {
  try {
    const parsed = JSON.parse(raw.toString()) as AgentToServerMessage;
    return parsed;
  } catch {
    return null;
  }
}

function apiError(reply: FastifyReply, statusCode: number, error: ApiError): FastifyReply {
  return reply.status(statusCode).send(error);
}

function isCommandBody(body: unknown): body is CommandRequest {
  if (!body || typeof body !== "object") {
    return false;
  }

  const candidate = body as Partial<CommandRequest>;
  return isCommandAction(candidate.action) && typeof candidate.profileId === "string";
}

function isCreateProfileBody(body: unknown): body is {
  id?: string;
  name: string;
  siteUrl: string;
  username: string;
  password: string;
} {
  if (!body || typeof body !== "object") {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.siteUrl === "string" &&
    typeof candidate.username === "string" &&
    typeof candidate.password === "string" &&
    (candidate.id === undefined || typeof candidate.id === "string")
  );
}

function isCreateDeviceBody(body: unknown): body is {
  id?: string;
  name: string;
  location: string;
  profileIds: string[];
} {
  if (!body || typeof body !== "object") {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.location === "string" &&
    Array.isArray(candidate.profileIds) &&
    candidate.profileIds.every((profileId) => typeof profileId === "string") &&
    (candidate.id === undefined || typeof candidate.id === "string")
  );
}

function isCreateWolGatewayBody(body: unknown): body is {
  id?: string;
  name: string;
  location: string;
} {
  if (!body || typeof body !== "object") {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.location === "string" &&
    (candidate.id === undefined || typeof candidate.id === "string")
  );
}

function isWolGatewayResultBody(body: unknown): body is {
  status: "succeeded" | "failed";
  output?: Record<string, unknown>;
  error?: string;
} {
  if (!body || typeof body !== "object") {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return (
    (candidate.status === "succeeded" || candidate.status === "failed") &&
    (candidate.output === undefined ||
      (typeof candidate.output === "object" && candidate.output !== null)) &&
    (candidate.error === undefined || typeof candidate.error === "string")
  );
}

function getGatewayCredentials(request: FastifyRequest): {
  gatewayId: string;
  token: string;
} | null {
  const query = request.query as { gatewayId?: string; token?: string };
  const bearerToken = getBearerToken(request);
  if (!query.gatewayId || (!query.token && !bearerToken)) {
    return null;
  }
  return {
    gatewayId: query.gatewayId,
    token: bearerToken ?? query.token ?? ""
  };
}

export async function createServer(config: AppConfig): Promise<FastifyInstance> {
  const store = config.databaseUrl
    ? await PostgresStore.create(config)
    : new AppStore(config);
  const agents = new Map<string, AgentConnection>();
  const server = Fastify({
    logger: true
  });

  await server.register(cors, {
    origin: true,
    credentials: true
  });
  await server.register(websocket);

  server.decorateRequest("userEmail", null);
  server.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) {
      return;
    }

    const token = getBearerToken(request);
    const session = token ? verifySessionToken(token, config.jwtSecret) : null;
    if (!session) {
      return apiError(reply, 401, {
        ok: false,
        code: "UNAUTHORIZED",
        message: "Sessao invalida ou expirada."
      });
    }

    request.userEmail = session.email;
  });

  server.addHook("onClose", async () => {
    if ("close" in store) {
      await store.close();
    }
  });

  server.get("/health", async () => ({
    ok: true,
    service: "radio-bot-api",
    database: config.databaseUrl ? "postgres" : "memory"
  }));

  server.post("/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    if (body?.email !== config.adminEmail || body?.password !== config.adminPassword) {
      return apiError(reply, 401, {
        ok: false,
        code: "INVALID_CREDENTIALS",
        message: "Email ou senha invalidos."
      });
    }

    return reply.send({
      ok: true,
      data: {
        token: createSessionToken(config.adminEmail, config.jwtSecret),
        email: config.adminEmail
      }
    });
  });

  server.get("/api/state", async () => ({
    ok: true,
    data: await store.getDashboardState()
  }));

  server.post("/api/profiles", async (request, reply) => {
    if (!isCreateProfileBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_PROFILE",
        message: "Dados da radio invalidos."
      });
    }

    const profile = await store.createProfile(request.body);
    return reply.status(201).send({
      ok: true,
      data: profile
    });
  });

  server.patch("/api/devices/:deviceId/wol", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const body = request.body as
      | {
          macAddress?: string | null;
          broadcastAddress?: string | null;
          wolGatewayId?: string | null;
        }
      | undefined;

    const rawMac = typeof body?.macAddress === "string" ? body.macAddress.trim() : "";
    const rawBroadcast =
      typeof body?.broadcastAddress === "string" ? body.broadcastAddress.trim() : "";
    const rawGatewayId =
      typeof body?.wolGatewayId === "string" ? body.wolGatewayId.trim() : "";

    if (rawMac && !/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(rawMac)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_MAC",
        message: "Endereco MAC invalido. Use o formato AA:BB:CC:DD:EE:FF."
      });
    }

    if (rawBroadcast && !/^(\d{1,3}\.){3}\d{1,3}$/.test(rawBroadcast)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_BROADCAST",
        message: "Endereco de broadcast invalido. Use o formato 192.168.1.255."
      });
    }

    if (rawGatewayId && !(await store.getWolGateway(rawGatewayId))) {
      return apiError(reply, 422, {
        ok: false,
        code: "WOL_GATEWAY_NOT_FOUND",
        message: "Gateway ESP32 nao encontrado."
      });
    }

    const device = await store.updateDeviceWol(deviceId, {
      macAddress: rawMac ? rawMac.toUpperCase().replace(/-/g, ":") : null,
      broadcastAddress: rawBroadcast || null,
      wolGatewayId: rawGatewayId || null
    });

    if (!device) {
      return apiError(reply, 404, {
        ok: false,
        code: "DEVICE_NOT_FOUND",
        message: "Computador nao encontrado."
      });
    }

    return reply.send({
      ok: true,
      data: {
        id: device.id,
        macAddress: device.macAddress,
        broadcastAddress: device.broadcastAddress,
        wolGatewayId: device.wolGatewayId
      }
    });
  });

  server.post("/api/wol-gateways", async (request, reply) => {
    if (!isCreateWolGatewayBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_WOL_GATEWAY",
        message: "Dados do gateway ESP32 invalidos."
      });
    }

    const gateway = await store.createWolGateway(request.body);
    return reply.status(201).send({
      ok: true,
      data: gateway
    });
  });

  server.post("/api/devices", async (request, reply) => {
    if (!isCreateDeviceBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_DEVICE",
        message: "Dados do computador invalidos."
      });
    }

    const device = await store.createDevice(request.body);
    return reply.status(201).send({
      ok: true,
      data: device
    });
  });

  server.post("/api/devices/:deviceId/commands", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const body = request.body;
    if (!isCommandBody(body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_COMMAND",
        message: "Comando invalido."
      });
    }

    const device = await store.getDevice(deviceId);
    if (!device) {
      return apiError(reply, 404, {
        ok: false,
        code: "DEVICE_NOT_FOUND",
        message: "Computador nao encontrado."
      });
    }

    const profile = await store.getProfile(body.profileId);
    const validationError = await store.assertDeviceCanUseProfile(deviceId, body.profileId);
    if (validationError || !profile) {
      return apiError(reply, 422, {
        ok: false,
        code: "PROFILE_NOT_ALLOWED",
        message: validationError ?? "Perfil nao permitido."
      });
    }

    if (body.action === "power_on") {
      if (!device.macAddress) {
        return apiError(reply, 422, {
          ok: false,
          code: "WOL_MAC_NOT_CONFIGURED",
          message: "Configure o endereco MAC deste computador antes de ligar por Wake on LAN."
        });
      }

      if (!device.wolGatewayId) {
        return apiError(reply, 422, {
          ok: false,
          code: "WOL_GATEWAY_NOT_CONFIGURED",
          message: "Associe este computador a um gateway ESP32 antes de ligar por Wake on LAN."
        });
      }

      const gateway = await store.getWolGateway(device.wolGatewayId);
      if (!gateway) {
        return apiError(reply, 422, {
          ok: false,
          code: "WOL_GATEWAY_NOT_FOUND",
          message: "Gateway ESP32 associado ao computador nao foi encontrado."
        });
      }

      const command = await store.createCommand({
        action: body.action,
        profileId: body.profileId,
        deviceId,
        requestedBy: request.userEmail ?? "unknown",
        payload: body.payload
      });
      return reply.send({
        ok: true,
        data: command
      });
    }

    const activeDevices = await store.listDevicesUsingProfile(body.profileId, deviceId);
    const confirmations = Number(body.confirmations ?? 0);
    if (activeDevices.length > 0 && confirmations < 2) {
      return apiError(reply, 409, {
        ok: false,
        code: "PROFILE_ACTIVE_ELSEWHERE",
        message: "Este perfil ja esta ativo em outro computador.",
        confirmation: {
          title: "Perfil ja esta ativo",
          message:
            "Este perfil ja aparece ativo em outro computador. Continuar pode derrubar uma sessao existente no site da radio. Quer continuar mesmo assim?",
          confirmLabel: "Continuar mesmo assim",
          requiredConfirmations: 2
        },
        conflict: {
          profileId: body.profileId,
          activeDevices,
          requiredConfirmations: 2
        }
      });
    }

    const agent = agents.get(deviceId);
    if (!agent || device.status !== "online") {
      return apiError(reply, 409, {
        ok: false,
        code: "DEVICE_OFFLINE",
        message: "Computador offline ou agente desconectado."
      });
    }

    if (body.action === "confirm_open_here") {
      await store.resolveWaitingCommands(deviceId);
    }

    const command = await store.createCommand({
      action: body.action,
      profileId: body.profileId,
      deviceId,
      requestedBy: request.userEmail ?? "unknown",
      payload: body.payload
    });

    sendAgentMessage(agent.socket, {
      type: "command",
      command: {
        id: command.id,
        action: command.action,
        profileId: command.profileId,
        payload: command.payload
      },
      profile
    });
    await store.markCommandSent(command.id);

    return reply.send({
      ok: true,
      data: command
    });
  });

  server.get("/wol-gateway/poll", async (request, reply) => {
    const credentials = getGatewayCredentials(request);
    if (
      !credentials ||
      !(await store.verifyWolGatewayToken(credentials.gatewayId, credentials.token))
    ) {
      return apiError(reply, 401, {
        ok: false,
        code: "INVALID_WOL_GATEWAY_CREDENTIALS",
        message: "Credenciais do gateway ESP32 invalidas."
      });
    }

    await store.markWolGatewayOnline(credentials.gatewayId);
    const command = await store.reserveWolCommand(credentials.gatewayId);
    return reply.send({
      ok: true,
      data: {
        gatewayId: credentials.gatewayId,
        command
      }
    });
  });

  server.post("/wol-gateway/commands/:commandId/result", async (request, reply) => {
    const credentials = getGatewayCredentials(request);
    if (
      !credentials ||
      !(await store.verifyWolGatewayToken(credentials.gatewayId, credentials.token))
    ) {
      return apiError(reply, 401, {
        ok: false,
        code: "INVALID_WOL_GATEWAY_CREDENTIALS",
        message: "Credenciais do gateway ESP32 invalidas."
      });
    }

    if (!isWolGatewayResultBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_WOL_RESULT",
        message: "Resultado do Wake on LAN invalido."
      });
    }

    const { commandId } = request.params as { commandId: string };
    await store.markWolGatewayOnline(credentials.gatewayId);
    const completed = await store.completeWolCommand(credentials.gatewayId, commandId, {
      status: request.body.status,
      output: request.body.output,
      error: request.body.error
    });

    if (!completed) {
      return apiError(reply, 404, {
        ok: false,
        code: "WOL_COMMAND_NOT_FOUND",
        message: "Comando Wake on LAN nao encontrado para este gateway."
      });
    }

    return reply.send({
      ok: true,
      data: {
        commandId
      }
    });
  });

  server.get("/agent", { websocket: true }, async (socket, request) => {
    const query = request.query as { deviceId?: string; token?: string };
    if (
      !query.deviceId ||
      !query.token ||
      !(await store.verifyDeviceToken(query.deviceId, query.token))
    ) {
      socket.close(1008, "invalid device credentials");
      return;
    }

    const deviceId = query.deviceId;
    agents.get(deviceId)?.socket.close(1000, "replaced by a new connection");
    agents.set(deviceId, {
      deviceId,
      socket
    });
    await store.markDeviceOnline(deviceId);
    sendAgentMessage(socket, {
      type: "registered",
      deviceId
    });

    socket.on("message", (raw) => {
      void (async () => {
        const message = parseAgentMessage(Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString()));
        if (!message) {
          return;
        }

        if (message.type === "heartbeat") {
          await store.markDeviceOnline(deviceId);
          if (message.state) {
            await store.updateDeviceState(deviceId, message.state);
          }
          return;
        }

        if (message.type === "agent_state") {
          await store.updateDeviceState(deviceId, message.state);
          return;
        }

        if (message.type === "command_result") {
          if (message.state) {
            await store.updateDeviceState(deviceId, message.state);
          }
          await store.completeCommand(message.commandId, {
            status: message.status,
            output: message.output,
            error: message.error,
            screenshot: message.screenshot
          });
        }
      })().catch((error: unknown) => {
        server.log.error(error);
      });
    });

    socket.on("close", () => {
      const current = agents.get(deviceId);
      if (current?.socket === socket) {
        agents.delete(deviceId);
        void store.markDeviceOffline(deviceId);
      }
    });
  });

  return server;
}

declare module "fastify" {
  interface FastifyRequest {
    userEmail?: string | null;
  }
}
