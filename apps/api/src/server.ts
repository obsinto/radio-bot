import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  type AgentToServerMessage,
  type ApiError,
  type CommandAction,
  type CommandRequest,
  type ScheduleInput,
  type ScheduleKind,
  type ScheduleRecord,
  type ScheduleStatus,
  type ScheduleUpdate,
  isCommandAction,
  type ServerToAgentMessage
} from "@radio-bot/shared";
import { createSessionToken, verifySessionToken } from "./auth.js";
import type { AppConfig } from "./config.js";
import { AppStore } from "./store.js";
import { PostgresStore } from "./postgres-store.js";
import {
  isValidTimeOfDay,
  isValidTimezone,
  nextRunAtForSchedule,
  normalizeDaysOfWeek,
  normalizeScheduleStatus
} from "./schedule-time.js";

type AgentConnection = {
  deviceId: string;
  socket: WebSocket;
};

type CommandCompletion = {
  status: "succeeded" | "failed" | "waiting_confirmation";
  error?: string;
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

const profileConflictActions = new Set<CommandAction>([
  "open_site",
  "login",
  "reload",
  "click_action",
  "confirm_open_here",
  "play_radio"
]);

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

function isUpdateProfileBody(body: unknown): body is {
  name?: string;
  siteUrl?: string;
  username?: string;
  password?: string;
} {
  if (!body || typeof body !== "object") {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return (
    (candidate.name === undefined || typeof candidate.name === "string") &&
    (candidate.siteUrl === undefined || typeof candidate.siteUrl === "string") &&
    (candidate.username === undefined || typeof candidate.username === "string") &&
    (candidate.password === undefined || typeof candidate.password === "string")
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

function isUpdateDeviceBody(body: unknown): body is {
  name?: string;
  location?: string;
} {
  if (!body || typeof body !== "object") {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return (
    (candidate.name === undefined || typeof candidate.name === "string") &&
    (candidate.location === undefined || typeof candidate.location === "string")
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

function isUpdateWolGatewayBody(body: unknown): body is {
  name?: string;
  location?: string;
} {
  return isUpdateDeviceBody(body);
}

function isScheduleKind(value: unknown): value is ScheduleKind {
  return value === "power_on_start" || value === "shutdown";
}

function isScheduleStatus(value: unknown): value is ScheduleStatus {
  return value === "enabled" || value === "disabled";
}

function isScheduleInputBody(body: unknown): body is ScheduleInput {
  if (!body || typeof body !== "object") {
    return false;
  }

  const candidate = body as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    isScheduleKind(candidate.kind) &&
    typeof candidate.deviceId === "string" &&
    (candidate.profileId === undefined ||
      candidate.profileId === null ||
      typeof candidate.profileId === "string") &&
    typeof candidate.timezone === "string" &&
    typeof candidate.timeOfDay === "string" &&
    Array.isArray(candidate.daysOfWeek) &&
    candidate.daysOfWeek.every((day) => typeof day === "number") &&
    (candidate.status === undefined || isScheduleStatus(candidate.status))
  );
}

function isScheduleUpdateBody(body: unknown): body is ScheduleUpdate {
  if (!body || typeof body !== "object") {
    return false;
  }

  const candidate = body as Record<string, unknown>;
  return (
    (candidate.name === undefined || typeof candidate.name === "string") &&
    (candidate.kind === undefined || isScheduleKind(candidate.kind)) &&
    (candidate.deviceId === undefined || typeof candidate.deviceId === "string") &&
    (candidate.profileId === undefined ||
      candidate.profileId === null ||
      typeof candidate.profileId === "string") &&
    (candidate.timezone === undefined || typeof candidate.timezone === "string") &&
    (candidate.timeOfDay === undefined || typeof candidate.timeOfDay === "string") &&
    (candidate.daysOfWeek === undefined ||
      (Array.isArray(candidate.daysOfWeek) &&
        candidate.daysOfWeek.every((day) => typeof day === "number"))) &&
    (candidate.status === undefined || isScheduleStatus(candidate.status))
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
  const commandWaiters = new Map<string, (completion: CommandCompletion) => void>();
  const runningScheduleIds = new Set<string>();
  const server = Fastify({
    logger: true
  });

  await server.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
  });
  await server.register(websocket);

  function resolveCommandWaiter(commandId: string, completion: CommandCompletion): void {
    const waiter = commandWaiters.get(commandId);
    if (!waiter) {
      return;
    }
    commandWaiters.delete(commandId);
    waiter(completion);
  }

  function waitForCommandCompletion(commandId: string, timeoutMs: number): Promise<CommandCompletion> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        commandWaiters.delete(commandId);
        resolve({
          status: "failed",
          error: "Tempo limite aguardando conclusao do comando."
        });
      }, timeoutMs);

      commandWaiters.set(commandId, (completion) => {
        clearTimeout(timeout);
        resolve(completion);
      });
    });
  }

  async function waitForDeviceOnline(deviceId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const device = await store.getDevice(deviceId);
      if (device?.status === "online" && agents.has(deviceId)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Tempo limite aguardando o computador ficar online.");
  }

  async function sendAgentCommandAndWait(input: {
    deviceId: string;
    profile: Awaited<ReturnType<typeof store.getProfile>>;
    action: CommandAction;
    requestedBy: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<string> {
    if (!input.profile) {
      throw new Error("Perfil de acesso nao encontrado para executar o comando.");
    }

    const device = await store.getDevice(input.deviceId);
    const agent = agents.get(input.deviceId);
    if (!device || !agent || device.status !== "online") {
      throw new Error("Computador offline ou agente desconectado.");
    }

    const command = await store.createCommand({
      action: input.action,
      profileId: input.profile.id,
      deviceId: input.deviceId,
      requestedBy: input.requestedBy,
      payload: input.payload
    });
    const completionPromise = waitForCommandCompletion(command.id, input.timeoutMs ?? 60000);

    sendAgentMessage(agent.socket, {
      type: "command",
      command: {
        id: command.id,
        action: command.action,
        profileId: command.profileId,
        payload: command.payload
      },
      profile: input.profile
    });
    await store.markCommandSent(command.id);

    const completion = await completionPromise;
    if (completion.status !== "succeeded") {
      throw new Error(completion.error ?? `Comando ${input.action} terminou com status ${completion.status}.`);
    }

    return command.id;
  }

  async function enqueuePowerOnCommand(input: {
    deviceId: string;
    profileId: string;
    requestedBy: string;
  }): Promise<string> {
    const device = await store.getDevice(input.deviceId);
    if (!device) {
      throw new Error("Computador nao encontrado.");
    }
    if (!device.macAddress) {
      throw new Error("Endereco MAC nao configurado para Wake on LAN.");
    }
    if (!device.wolGatewayId) {
      throw new Error("Gateway Wake on LAN nao configurado para este computador.");
    }
    if (!(await store.getWolGateway(device.wolGatewayId))) {
      throw new Error("Gateway Wake on LAN associado nao encontrado.");
    }

    const command = await store.createCommand({
      action: "power_on",
      profileId: input.profileId,
      deviceId: input.deviceId,
      requestedBy: input.requestedBy,
      payload: {}
    });
    return command.id;
  }

  async function executionProfile(schedule: ScheduleRecord) {
    if (schedule.profileId) {
      return store.getProfile(schedule.profileId);
    }

    const device = await store.getDevice(schedule.deviceId);
    const fallbackProfileId = device?.profileIds[0];
    return fallbackProfileId ? store.getProfile(fallbackProfileId) : null;
  }

  async function runSchedule(schedule: ScheduleRecord, runId: string, requestedBy: string): Promise<void> {
    const commandIds: string[] = [];
    try {
      if (schedule.kind === "power_on_start") {
        if (!schedule.profileId) {
          throw new Error("Agendamento de ligar e iniciar precisa de uma radio.");
        }

        const profile = await store.getProfile(schedule.profileId);
        if (!profile) {
          throw new Error("Radio do agendamento nao encontrada.");
        }

        const device = await store.getDevice(schedule.deviceId);
        if (!device) {
          throw new Error("Computador do agendamento nao encontrado.");
        }

        if (device.status !== "online" || !agents.has(device.id)) {
          commandIds.push(
            await enqueuePowerOnCommand({
              deviceId: schedule.deviceId,
              profileId: schedule.profileId,
              requestedBy
            })
          );
          await waitForDeviceOnline(schedule.deviceId, 180000);
        }

        commandIds.push(
          await sendAgentCommandAndWait({
            deviceId: schedule.deviceId,
            profile,
            action: profile.username && profile.password ? "login" : "open_site",
            requestedBy
          })
        );
      } else {
        const profile = await executionProfile(schedule);
        commandIds.push(
          await sendAgentCommandAndWait({
            deviceId: schedule.deviceId,
            profile,
            action: "shutdown",
            requestedBy,
            payload: {
              delaySeconds: 60,
              force: false
            },
            timeoutMs: 15000
          })
        );
      }

      await store.completeScheduleRun(runId, {
        status: "succeeded",
        commandIds
      });
    } catch (error) {
      await store.completeScheduleRun(runId, {
        status: "failed",
        error: (error as Error).message,
        commandIds
      });
    } finally {
      runningScheduleIds.delete(schedule.id);
    }
  }

  async function startScheduleExecution(
    schedule: ScheduleRecord,
    requestedBy: string,
    reschedule: boolean
  ) {
    if (runningScheduleIds.has(schedule.id)) {
      throw new Error("Este agendamento ja esta em execucao.");
    }

    runningScheduleIds.add(schedule.id);
    if (reschedule) {
      await store.markScheduleTriggered(
        schedule.id,
        nextRunAtForSchedule(schedule, new Date(Date.now() + 60000))
      );
    }
    const run = await store.createScheduleRun(schedule.id);
    void runSchedule(schedule, run.id, requestedBy).catch((error: unknown) => {
      server.log.error(error);
      runningScheduleIds.delete(schedule.id);
    });
    return run;
  }

  async function runDueSchedules(): Promise<void> {
    const now = Date.now();
    const schedules = await store.listSchedules();
    for (const schedule of schedules) {
      if (
        schedule.status === "enabled" &&
        schedule.nextRunAt &&
        new Date(schedule.nextRunAt).getTime() <= now &&
        !runningScheduleIds.has(schedule.id)
      ) {
        await startScheduleExecution(schedule, "scheduler", true).catch((error: unknown) => {
          server.log.error(error);
        });
      }
    }
  }

  function normalizeScheduleInput(input: ScheduleInput): ScheduleInput & { nextRunAt: string | null } {
    const status = normalizeScheduleStatus(input.status);
    const normalized = {
      ...input,
      name: input.name.trim(),
      deviceId: input.deviceId.trim(),
      profileId: input.profileId?.trim() || null,
      timezone: input.timezone.trim(),
      timeOfDay: input.timeOfDay.trim(),
      daysOfWeek: normalizeDaysOfWeek(input.daysOfWeek),
      status
    };

    return {
      ...normalized,
      nextRunAt: nextRunAtForSchedule(normalized)
    };
  }

  async function validateSchedule(input: ScheduleInput): Promise<{
    statusCode: number;
    error: ApiError;
  } | null> {
    if (!input.name.trim()) {
      return {
        statusCode: 400,
        error: {
          ok: false,
          code: "INVALID_SCHEDULE_NAME",
          message: "Nome do agendamento e obrigatorio."
        }
      };
    }

    if (!isValidTimezone(input.timezone)) {
      return {
        statusCode: 400,
        error: {
          ok: false,
          code: "INVALID_TIMEZONE",
          message: "Timezone invalida."
        }
      };
    }

    if (!isValidTimeOfDay(input.timeOfDay)) {
      return {
        statusCode: 400,
        error: {
          ok: false,
          code: "INVALID_TIME_OF_DAY",
          message: "Horario invalido. Use HH:mm."
        }
      };
    }

    if (normalizeDaysOfWeek(input.daysOfWeek).length === 0) {
      return {
        statusCode: 400,
        error: {
          ok: false,
          code: "INVALID_DAYS_OF_WEEK",
          message: "Escolha pelo menos um dia da semana."
        }
      };
    }

    const device = await store.getDevice(input.deviceId);
    if (!device) {
      return {
        statusCode: 404,
        error: {
          ok: false,
          code: "DEVICE_NOT_FOUND",
          message: "Computador nao encontrado."
        }
      };
    }

    if (input.kind === "power_on_start" && !input.profileId) {
      return {
        statusCode: 400,
        error: {
          ok: false,
          code: "PROFILE_REQUIRED",
          message: "Agendamento de ligar e iniciar precisa de uma radio."
        }
      };
    }

    if (input.profileId) {
      const validationError = await store.assertDeviceCanUseProfile(input.deviceId, input.profileId);
      if (validationError) {
        return {
          statusCode: 422,
          error: {
            ok: false,
            code: "PROFILE_NOT_ALLOWED",
            message: validationError
          }
        };
      }
    }

    return null;
  }

  const scheduleInterval = setInterval(() => {
    void runDueSchedules().catch((error: unknown) => {
      server.log.error(error);
    });
  }, 30000);
  scheduleInterval.unref();

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
    clearInterval(scheduleInterval);
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

  server.get("/api/schedules", async () => ({
    ok: true,
    data: await store.listSchedules()
  }));

  server.post("/api/schedules", async (request, reply) => {
    if (!isScheduleInputBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_SCHEDULE",
        message: "Dados do agendamento invalidos."
      });
    }

    const input = normalizeScheduleInput(request.body);
    const validationError = await validateSchedule(input);
    if (validationError) {
      return apiError(reply, validationError.statusCode, validationError.error);
    }

    const schedule = await store.createSchedule(input);
    return reply.status(201).send({
      ok: true,
      data: schedule
    });
  });

  server.patch("/api/schedules/:scheduleId", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    if (!isScheduleUpdateBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_SCHEDULE",
        message: "Dados do agendamento invalidos."
      });
    }

    const current = await store.getSchedule(scheduleId);
    if (!current) {
      return apiError(reply, 404, {
        ok: false,
        code: "SCHEDULE_NOT_FOUND",
        message: "Agendamento nao encontrado."
      });
    }

    const body = request.body;
    const merged = normalizeScheduleInput({
      name: body.name ?? current.name,
      kind: body.kind ?? current.kind,
      deviceId: body.deviceId ?? current.deviceId,
      profileId:
        "profileId" in body
          ? body.profileId ?? null
          : body.kind === "shutdown"
            ? null
            : current.profileId,
      timezone: body.timezone ?? current.timezone,
      timeOfDay: body.timeOfDay ?? current.timeOfDay,
      daysOfWeek: body.daysOfWeek ?? current.daysOfWeek,
      status: body.status ?? current.status
    });
    const validationError = await validateSchedule(merged);
    if (validationError) {
      return apiError(reply, validationError.statusCode, validationError.error);
    }

    const schedule = await store.updateSchedule(scheduleId, merged);
    return reply.send({
      ok: true,
      data: schedule
    });
  });

  server.delete("/api/schedules/:scheduleId", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const deleted = await store.deleteSchedule(scheduleId);
    if (!deleted) {
      return apiError(reply, 404, {
        ok: false,
        code: "SCHEDULE_NOT_FOUND",
        message: "Agendamento nao encontrado."
      });
    }

    return reply.send({
      ok: true,
      data: {
        id: scheduleId
      }
    });
  });

  server.post("/api/schedules/:scheduleId/run-now", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    const schedule = await store.getSchedule(scheduleId);
    if (!schedule) {
      return apiError(reply, 404, {
        ok: false,
        code: "SCHEDULE_NOT_FOUND",
        message: "Agendamento nao encontrado."
      });
    }

    try {
      const run = await startScheduleExecution(schedule, request.userEmail ?? "unknown", false);
      return reply.status(202).send({
        ok: true,
        data: run
      });
    } catch (error) {
      return apiError(reply, 409, {
        ok: false,
        code: "SCHEDULE_ALREADY_RUNNING",
        message: (error as Error).message
      });
    }
  });

  server.get("/api/schedules/:scheduleId/runs", async (request, reply) => {
    const { scheduleId } = request.params as { scheduleId: string };
    if (!(await store.getSchedule(scheduleId))) {
      return apiError(reply, 404, {
        ok: false,
        code: "SCHEDULE_NOT_FOUND",
        message: "Agendamento nao encontrado."
      });
    }

    return reply.send({
      ok: true,
      data: await store.listScheduleRuns(scheduleId)
    });
  });

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

  server.patch("/api/profiles/:profileId", async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    if (!isUpdateProfileBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_PROFILE",
        message: "Dados da radio invalidos."
      });
    }

    const body = request.body;
    const profile = await store.updateProfile(profileId, {
      name: body.name,
      siteUrl: body.siteUrl,
      username: body.username,
      password: body.password
    });

    if (!profile) {
      return apiError(reply, 404, {
        ok: false,
        code: "PROFILE_NOT_FOUND",
        message: "Radio nao encontrada."
      });
    }

    return reply.send({
      ok: true,
      data: profile
    });
  });

  server.delete("/api/profiles/:profileId", async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const deleted = await store.deleteProfile(profileId);
    if (!deleted) {
      return apiError(reply, 404, {
        ok: false,
        code: "PROFILE_NOT_FOUND",
        message: "Radio nao encontrada."
      });
    }

    return reply.send({
      ok: true,
      data: {
        id: profileId
      }
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

  server.post("/api/wol-gateways/:gatewayId/rotate-token", async (request, reply) => {
    const { gatewayId } = request.params as { gatewayId: string };
    const gateway = await store.rotateWolGatewayToken(gatewayId);
    if (!gateway) {
      return apiError(reply, 404, {
        ok: false,
        code: "WOL_GATEWAY_NOT_FOUND",
        message: "Gateway ESP32 nao encontrado."
      });
    }

    return reply.send({
      ok: true,
      data: gateway
    });
  });

  server.patch("/api/wol-gateways/:gatewayId", async (request, reply) => {
    const { gatewayId } = request.params as { gatewayId: string };
    if (!isUpdateWolGatewayBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_WOL_GATEWAY",
        message: "Dados do gateway ESP32 invalidos."
      });
    }

    const gateway = await store.updateWolGateway(gatewayId, request.body);
    if (!gateway) {
      return apiError(reply, 404, {
        ok: false,
        code: "WOL_GATEWAY_NOT_FOUND",
        message: "Gateway ESP32 nao encontrado."
      });
    }

    return reply.send({
      ok: true,
      data: gateway
    });
  });

  server.delete("/api/wol-gateways/:gatewayId", async (request, reply) => {
    const { gatewayId } = request.params as { gatewayId: string };
    const deleted = await store.deleteWolGateway(gatewayId);
    if (!deleted) {
      return apiError(reply, 404, {
        ok: false,
        code: "WOL_GATEWAY_NOT_FOUND",
        message: "Gateway ESP32 nao encontrado."
      });
    }

    return reply.send({
      ok: true,
      data: {
        id: gatewayId
      }
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

  server.patch("/api/devices/:deviceId", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    if (!isUpdateDeviceBody(request.body)) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_DEVICE",
        message: "Dados do computador invalidos."
      });
    }

    const device = await store.updateDevice(deviceId, request.body);
    if (!device) {
      return apiError(reply, 404, {
        ok: false,
        code: "DEVICE_NOT_FOUND",
        message: "Computador nao encontrado."
      });
    }

    return reply.send({
      ok: true,
      data: device
    });
  });

  server.delete("/api/devices/:deviceId", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const deleted = await store.deleteDevice(deviceId);
    if (!deleted) {
      return apiError(reply, 404, {
        ok: false,
        code: "DEVICE_NOT_FOUND",
        message: "Computador nao encontrado."
      });
    }

    const agent = agents.get(deviceId);
    if (agent) {
      agents.delete(deviceId);
      agent.socket.close(1000, "device deleted");
    }

    return reply.send({
      ok: true,
      data: {
        id: deviceId
      }
    });
  });

  server.patch("/api/devices/:deviceId/profiles", async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const body = request.body as { profileIds?: unknown } | undefined;

    if (
      !body ||
      !Array.isArray(body.profileIds) ||
      !body.profileIds.every((profileId) => typeof profileId === "string")
    ) {
      return apiError(reply, 400, {
        ok: false,
        code: "INVALID_PROFILE_IDS",
        message: "Lista de radios invalida."
      });
    }

    const device = await store.updateDeviceProfiles(deviceId, body.profileIds as string[]);
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
        profileIds: device.profileIds
      }
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

    const confirmations = Number(body.confirmations ?? 0);
    const activeDevices = profileConflictActions.has(body.action)
      ? await store.listDevicesUsingProfile(body.profileId, deviceId)
      : [];
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
    if (completed) {
      resolveCommandWaiter(commandId, {
        status: request.body.status,
        error: request.body.error
      });
    }

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
    const query = request.query as { deviceId?: string; token?: string; validateOnly?: string };
    if (
      !query.deviceId ||
      !query.token ||
      !(await store.verifyDeviceToken(query.deviceId, query.token))
    ) {
      socket.close(1008, "invalid device credentials");
      return;
    }

    const deviceId = query.deviceId;
    if (query.validateOnly === "1") {
      sendAgentMessage(socket, {
        type: "registered",
        deviceId
      });
      setTimeout(() => socket.close(1000, "validation complete"), 1000);
      return;
    }

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
          resolveCommandWaiter(message.commandId, {
            status: message.status,
            error: message.error
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
