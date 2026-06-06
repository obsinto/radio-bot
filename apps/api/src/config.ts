import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import type { Device, SiteProfile, WolGateway } from "@radio-bot/shared";

const moduleDir = dirname(fileURLToPath(import.meta.url));
loadDotEnv({
  path: resolve(moduleDir, "../../../.env"),
  quiet: true
});
loadDotEnv({
  path: resolve(moduleDir, "../.env"),
  override: true,
  quiet: true
});

export type DeviceSeed = Omit<
  Device,
  | "status"
  | "lastSeenAt"
  | "currentProfileId"
  | "activeUrl"
  | "title"
  | "macAddress"
  | "broadcastAddress"
  | "wolGatewayId"
> & {
  macAddress?: string | null;
  broadcastAddress?: string | null;
  wolGatewayId?: string | null;
};

export type WolGatewaySeed = Omit<WolGateway, "status" | "lastSeenAt">;

function parseJsonEnv<T>(name: string): T | null {
  const value = process.env[name];
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Variavel ${name} nao contem JSON valido: ${(error as Error).message}`);
  }
}

export type AppConfig = {
  port: number;
  host: string;
  appUrl: string;
  jwtSecret: string;
  adminEmail: string;
  adminPassword: string;
  databaseUrl: string | null;
  encryptionKey: string;
  profiles: SiteProfile[];
  devices: DeviceSeed[];
  wolGateways: WolGatewaySeed[];
  autoRecover: AutoRecoverConfig;
};

export type AutoRecoverConfig = {
  enabled: boolean;
  graceMs: number;
  backoffMs: number;
  intentionalWindowMs: number;
  scanIntervalMs?: number;
};

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  const profiles = parseJsonEnv<SiteProfile[]>("SITE_PROFILES_JSON") ?? [];
  const wolGateways = parseJsonEnv<WolGatewaySeed[]>("WOL_GATEWAYS_JSON") ?? [];
  const devices = parseJsonEnv<DeviceSeed[]>("DEVICES_JSON") ?? [];

  return {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || "0.0.0.0",
    appUrl: process.env.APP_URL || "http://localhost:5173",
    jwtSecret: process.env.JWT_SECRET || "dev-only-change-this-secret",
    adminEmail: process.env.ADMIN_EMAIL || "admin@radio.local",
    adminPassword: process.env.ADMIN_PASSWORD || "change-me",
    databaseUrl: process.env.DATABASE_URL || null,
    encryptionKey:
      process.env.ENCRYPTION_KEY ||
      process.env.JWT_SECRET ||
      "dev-only-change-this-encryption-key",
    profiles,
    devices,
    wolGateways,
    autoRecover: {
      enabled: parseBooleanEnv("AUTO_RECOVER_ENABLED", true),
      graceMs: parsePositiveIntEnv("AUTO_RECOVER_GRACE_MS", 90000),
      backoffMs: parsePositiveIntEnv("AUTO_RECOVER_BACKOFF_MS", 300000),
      intentionalWindowMs: parsePositiveIntEnv("AUTO_RECOVER_INTENTIONAL_WINDOW_MS", 900000),
      scanIntervalMs: parsePositiveIntEnv("AUTO_RECOVER_SCAN_INTERVAL_MS", 30000)
    }
  };
}
