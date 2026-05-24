import { randomUUID } from "node:crypto";
import {
  type CommandAction,
  type CommandPayload,
  type CommandRecord,
  type DashboardState,
  type Device,
  type SafeDevice,
  type SafeSiteProfile,
  type SafeWolGateway,
  type ScheduleInput,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleUpdate,
  type SiteProfile,
  type WolGateway,
  type WolGatewayCommand,
  toSafeDevice,
  toSafeProfile,
  toSafeWolGateway
} from "@radio-bot/shared";
import type { AppConfig } from "./config.js";

const WOL_GATEWAY_FRESH_MS = 45000;

export class AppStore {
  private readonly profiles = new Map<string, SiteProfile>();
  private readonly devices = new Map<string, Device>();
  private readonly wolGateways = new Map<string, WolGateway>();
  private readonly commands = new Map<string, CommandRecord>();
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly scheduleRuns = new Map<string, ScheduleRunRecord>();

  constructor(config: AppConfig) {
    for (const profile of config.profiles) {
      this.profiles.set(profile.id, profile);
    }

    for (const device of config.devices) {
      this.devices.set(device.id, {
        ...device,
        status: "offline",
        lastSeenAt: null,
        currentProfileId: null,
        activeUrl: null,
        title: null,
        macAddress: device.macAddress ?? null,
        broadcastAddress: device.broadcastAddress ?? null,
        wolGatewayId: device.wolGatewayId ?? null
      });
    }

    for (const gateway of config.wolGateways) {
      this.wolGateways.set(gateway.id, {
        ...gateway,
        status: "offline",
        lastSeenAt: null
      });
    }
  }

  getDashboardState(): DashboardState {
    return {
      profiles: this.listSafeProfiles(),
      devices: this.listSafeDevices(),
      wolGateways: this.listSafeWolGateways(),
      commands: this.listRecentCommands(),
      schedules: this.listSchedules(),
      scheduleRuns: this.listRecentScheduleRuns()
    };
  }

  listSafeProfiles(): SafeSiteProfile[] {
    return [...this.profiles.values()].map(toSafeProfile);
  }

  listSafeDevices(): SafeDevice[] {
    return [...this.devices.values()].map(toSafeDevice);
  }

  listSafeWolGateways(): SafeWolGateway[] {
    return [...this.wolGateways.values()].map((gateway) =>
      toSafeWolGateway({
        ...gateway,
        status: this.isGatewayFresh(gateway) ? "online" : "offline"
      })
    );
  }

  listRecentCommands(): CommandRecord[] {
    return [...this.commands.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30);
  }

  listSchedules(): ScheduleRecord[] {
    return [...this.schedules.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listRecentScheduleRuns(limit = 30): ScheduleRunRecord[] {
    return [...this.scheduleRuns.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  listScheduleRuns(scheduleId: string, limit = 30): ScheduleRunRecord[] {
    return [...this.scheduleRuns.values()]
      .filter((run) => run.scheduleId === scheduleId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  getSchedule(scheduleId: string): ScheduleRecord | null {
    return this.schedules.get(scheduleId) ?? null;
  }

  createSchedule(input: ScheduleInput & { nextRunAt: string | null }): ScheduleRecord {
    const id = this.uniqueId(input.name, this.schedules);
    const now = new Date().toISOString();
    const schedule: ScheduleRecord = {
      id,
      name: input.name.trim(),
      kind: input.kind,
      deviceId: input.deviceId,
      profileId: input.profileId ?? null,
      timezone: input.timezone,
      timeOfDay: input.timeOfDay,
      daysOfWeek: input.daysOfWeek,
      status: input.status ?? "enabled",
      lastRunAt: null,
      nextRunAt: input.nextRunAt,
      createdAt: now,
      updatedAt: now
    };
    this.schedules.set(id, schedule);
    return schedule;
  }

  updateSchedule(
    scheduleId: string,
    update: ScheduleUpdate & { nextRunAt?: string | null }
  ): ScheduleRecord | null {
    const schedule = this.getSchedule(scheduleId);
    if (!schedule) {
      return null;
    }

    const next: ScheduleRecord = {
      ...schedule,
      name: update.name?.trim() ?? schedule.name,
      kind: update.kind ?? schedule.kind,
      deviceId: update.deviceId ?? schedule.deviceId,
      profileId: "profileId" in update ? update.profileId ?? null : schedule.profileId,
      timezone: update.timezone ?? schedule.timezone,
      timeOfDay: update.timeOfDay ?? schedule.timeOfDay,
      daysOfWeek: update.daysOfWeek ?? schedule.daysOfWeek,
      status: update.status ?? schedule.status,
      nextRunAt: "nextRunAt" in update ? update.nextRunAt ?? null : schedule.nextRunAt,
      updatedAt: new Date().toISOString()
    };
    this.schedules.set(scheduleId, next);
    return next;
  }

  deleteSchedule(scheduleId: string): boolean {
    return this.schedules.delete(scheduleId);
  }

  createScheduleRun(scheduleId: string): ScheduleRunRecord {
    const now = new Date().toISOString();
    const run: ScheduleRunRecord = {
      id: randomUUID(),
      scheduleId,
      startedAt: now,
      finishedAt: null,
      status: "running",
      error: null,
      commandIds: []
    };
    this.scheduleRuns.set(run.id, run);
    return run;
  }

  completeScheduleRun(
    runId: string,
    result: {
      status: Exclude<ScheduleRunStatus, "running">;
      error?: string | null;
      commandIds: string[];
    }
  ): ScheduleRunRecord | null {
    const run = this.scheduleRuns.get(runId);
    if (!run) {
      return null;
    }

    const next: ScheduleRunRecord = {
      ...run,
      finishedAt: new Date().toISOString(),
      status: result.status,
      error: result.error ?? null,
      commandIds: result.commandIds
    };
    this.scheduleRuns.set(runId, next);
    return next;
  }

  markScheduleTriggered(scheduleId: string, nextRunAt: string | null): ScheduleRecord | null {
    const schedule = this.getSchedule(scheduleId);
    if (!schedule) {
      return null;
    }

    const next: ScheduleRecord = {
      ...schedule,
      lastRunAt: new Date().toISOString(),
      nextRunAt,
      updatedAt: new Date().toISOString()
    };
    this.schedules.set(scheduleId, next);
    return next;
  }

  createProfile(input: {
    id?: string;
    name: string;
    siteUrl: string;
    username: string;
    password: string;
  }): SafeSiteProfile {
    const id = this.uniqueId(input.id ?? input.name, this.profiles);
    const profile: SiteProfile = {
      id,
      name: input.name.trim(),
      siteUrl: input.siteUrl.trim(),
      username: input.username.trim(),
      password: input.password
    };
    this.profiles.set(id, profile);
    return toSafeProfile(profile);
  }

  updateProfile(
    profileId: string,
    update: Partial<Pick<SiteProfile, "name" | "siteUrl" | "username" | "password">>
  ): SafeSiteProfile | null {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      return null;
    }

    const next: SiteProfile = {
      ...profile,
      name: update.name?.trim() ?? profile.name,
      siteUrl: update.siteUrl?.trim() ?? profile.siteUrl,
      username: update.username?.trim() ?? profile.username,
      password: update.password ?? profile.password
    };
    this.profiles.set(profileId, next);
    return toSafeProfile(next);
  }

  createDevice(input: {
    id?: string;
    name: string;
    location: string;
    profileIds: string[];
  }): SafeDevice & { token: string } {
    const id = this.uniqueId(input.id ?? input.name, this.devices);
    const token = randomUUID();
    const allowedProfileIds = input.profileIds.filter((profileId) => this.profiles.has(profileId));
    const device: Device = {
      id,
      name: input.name.trim(),
      location: input.location.trim(),
      token,
      profileIds: allowedProfileIds.length > 0 ? allowedProfileIds : [...this.profiles.keys()],
      status: "offline",
      lastSeenAt: null,
      currentProfileId: null,
      activeUrl: null,
      title: null,
      macAddress: null,
      broadcastAddress: null,
      wolGatewayId: null
    };
    this.devices.set(id, device);
    return {
      ...toSafeDevice(device),
      token
    };
  }

  updateDevice(
    deviceId: string,
    update: Partial<Pick<Device, "name" | "location">>
  ): SafeDevice | null {
    const device = this.getDevice(deviceId);
    if (!device) {
      return null;
    }

    device.name = update.name?.trim() ?? device.name;
    device.location = update.location?.trim() ?? device.location;
    return toSafeDevice(device);
  }

  createWolGateway(input: {
    id?: string;
    name: string;
    location: string;
  }): SafeWolGateway & { token: string } {
    const id = this.uniqueId(input.id ?? input.name, this.wolGateways);
    const token = randomUUID();
    const gateway: WolGateway = {
      id,
      name: input.name.trim(),
      location: input.location.trim(),
      token,
      status: "offline",
      lastSeenAt: null
    };
    this.wolGateways.set(id, gateway);
    return {
      ...toSafeWolGateway(gateway),
      token
    };
  }

  updateWolGateway(
    gatewayId: string,
    update: Partial<Pick<WolGateway, "name" | "location">>
  ): SafeWolGateway | null {
    const gateway = this.getWolGateway(gatewayId);
    if (!gateway) {
      return null;
    }

    gateway.name = update.name?.trim() ?? gateway.name;
    gateway.location = update.location?.trim() ?? gateway.location;
    return toSafeWolGateway(gateway);
  }

  getProfile(profileId: string): SiteProfile | null {
    return this.profiles.get(profileId) ?? null;
  }

  getDevice(deviceId: string): Device | null {
    return this.devices.get(deviceId) ?? null;
  }

  getSafeDevice(deviceId: string): SafeDevice | null {
    const device = this.getDevice(deviceId);
    return device ? toSafeDevice(device) : null;
  }

  getWolGateway(gatewayId: string): WolGateway | null {
    return this.wolGateways.get(gatewayId) ?? null;
  }

  verifyDeviceToken(deviceId: string, token: string): boolean {
    const device = this.getDevice(deviceId);
    return Boolean(device && device.token === token);
  }

  verifyWolGatewayToken(gatewayId: string, token: string): boolean {
    const gateway = this.getWolGateway(gatewayId);
    return Boolean(gateway && gateway.token === token);
  }

  markDeviceOnline(deviceId: string): Device | null {
    const device = this.getDevice(deviceId);
    if (!device) {
      return null;
    }

    device.status = "online";
    device.lastSeenAt = new Date().toISOString();
    return device;
  }

  markDeviceOffline(deviceId: string): void {
    const device = this.getDevice(deviceId);
    if (!device) {
      return;
    }

    device.status = "offline";
    device.lastSeenAt = new Date().toISOString();
  }

  markWolGatewayOnline(gatewayId: string): WolGateway | null {
    const gateway = this.getWolGateway(gatewayId);
    if (!gateway) {
      return null;
    }

    gateway.status = "online";
    gateway.lastSeenAt = new Date().toISOString();
    return gateway;
  }

  updateDeviceState(
    deviceId: string,
    state: Partial<Pick<Device, "currentProfileId" | "activeUrl" | "title">>
  ): void {
    const device = this.getDevice(deviceId);
    if (!device) {
      return;
    }

    device.lastSeenAt = new Date().toISOString();
    device.currentProfileId = state.currentProfileId ?? device.currentProfileId;
    device.activeUrl = state.activeUrl ?? device.activeUrl;
    device.title = state.title ?? device.title;
  }

  assertDeviceCanUseProfile(deviceId: string, profileId: string): string | null {
    const device = this.getDevice(deviceId);
    if (!device) {
      return "Computador nao encontrado.";
    }
    if (!this.profiles.has(profileId)) {
      return "Perfil de acesso nao encontrado.";
    }
    if (!device.profileIds.includes(profileId)) {
      return "Este computador nao esta vinculado ao perfil selecionado.";
    }
    return null;
  }

  listDevicesUsingProfile(profileId: string, exceptDeviceId: string): SafeDevice[] {
    return [...this.devices.values()]
      .filter(
        (device) =>
          device.id !== exceptDeviceId &&
          device.status === "online" &&
          device.currentProfileId === profileId
      )
      .map(toSafeDevice);
  }

  createCommand(input: {
    action: CommandAction;
    profileId: string;
    deviceId: string;
    requestedBy: string;
    payload?: CommandPayload;
  }): CommandRecord {
    const now = new Date().toISOString();
    const command: CommandRecord = {
      id: randomUUID(),
      action: input.action,
      profileId: input.profileId,
      deviceId: input.deviceId,
      requestedBy: input.requestedBy,
      payload: input.payload ?? {},
      status: "queued",
      createdAt: now,
      updatedAt: now,
      error: null,
      output: null,
      screenshot: null
    };
    this.commands.set(command.id, command);
    return command;
  }

  markCommandSent(commandId: string): void {
    this.patchCommand(commandId, { status: "sent" });
  }

  completeCommand(
    commandId: string,
    result: {
      status: "succeeded" | "failed" | "waiting_confirmation";
      output?: Record<string, unknown>;
      error?: string;
      screenshot?: string;
    }
  ): void {
    this.patchCommand(commandId, {
      status: result.status,
      output: result.output ?? null,
      error: result.error ?? null,
      screenshot: result.screenshot ?? null
    });
  }

  updateDeviceWol(
    deviceId: string,
    update: {
      macAddress: string | null;
      broadcastAddress: string | null;
      wolGatewayId: string | null;
    }
  ): Device | null {
    const device = this.getDevice(deviceId);
    if (!device) {
      return null;
    }

    device.macAddress = update.macAddress;
    device.broadcastAddress = update.broadcastAddress;
    device.wolGatewayId = update.wolGatewayId;
    return device;
  }

  updateDeviceProfiles(deviceId: string, profileIds: string[]): Device | null {
    const device = this.getDevice(deviceId);
    if (!device) {
      return null;
    }

    const allowed = profileIds.filter((profileId) => this.profiles.has(profileId));
    device.profileIds = allowed;
    return device;
  }

  reserveWolCommand(gatewayId: string): WolGatewayCommand | null {
    const commands = [...this.commands.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );

    for (const command of commands) {
      if (command.action !== "power_on" || command.status !== "queued") {
        continue;
      }

      const device = this.getDevice(command.deviceId);
      if (
        !device ||
        device.wolGatewayId !== gatewayId ||
        !device.macAddress
      ) {
        continue;
      }

      this.markCommandSent(command.id);
      return {
        id: command.id,
        deviceId: device.id,
        deviceName: device.name,
        macAddress: device.macAddress,
        broadcastAddress: device.broadcastAddress
      };
    }

    return null;
  }

  completeWolCommand(
    gatewayId: string,
    commandId: string,
    result: {
      status: "succeeded" | "failed";
      output?: Record<string, unknown>;
      error?: string;
    }
  ): boolean {
    const command = this.commands.get(commandId);
    const device = command ? this.getDevice(command.deviceId) : null;
    if (!command || command.action !== "power_on" || device?.wolGatewayId !== gatewayId) {
      return false;
    }

    this.completeCommand(commandId, result);
    return true;
  }

  resolveWaitingCommands(deviceId: string): void {
    for (const command of this.commands.values()) {
      if (command.deviceId === deviceId && command.status === "waiting_confirmation") {
        Object.assign(command, {
          status: "succeeded",
          updatedAt: new Date().toISOString()
        });
      }
    }
  }

  private patchCommand(
    commandId: string,
    patch: Partial<Pick<CommandRecord, "status" | "output" | "error" | "screenshot">>
  ): void {
    const command = this.commands.get(commandId);
    if (!command) {
      return;
    }

    Object.assign(command, patch, {
      updatedAt: new Date().toISOString()
    });
  }

  private uniqueId(seed: string, map: Map<string, unknown>): string {
    const base =
      seed
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || randomUUID();

    if (!map.has(base)) {
      return base;
    }

    let index = 2;
    while (map.has(`${base}-${index}`)) {
      index += 1;
    }
    return `${base}-${index}`;
  }

  private isGatewayFresh(gateway: WolGateway): boolean {
    if (!gateway.lastSeenAt) {
      return false;
    }
    return Date.now() - new Date(gateway.lastSeenAt).getTime() <= WOL_GATEWAY_FRESH_MS;
  }
}
