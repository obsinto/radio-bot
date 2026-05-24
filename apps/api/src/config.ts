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
};

export function loadConfig(): AppConfig {
  const profiles = parseJsonEnv<SiteProfile[]>("SITE_PROFILES_JSON") ?? [
    {
      id: "oliveira-fm",
      name: "Oliveira FM",
      siteUrl: process.env.SITE_URL ?? "https://www.oliveirafm.com.br/",
      username: process.env.SITE_USERNAME ?? "",
      password: process.env.SITE_PASSWORD ?? ""
    }
  ];

  const defaultProfileIds = profiles.map((profile) => profile.id);
  const wolGateways = parseJsonEnv<WolGatewaySeed[]>("WOL_GATEWAYS_JSON") ?? [
    {
      id: "esp-studio-01",
      name: "Gateway ESP32 Studio 01",
      location: "Local principal",
      token: process.env.WOL_GATEWAY_TOKEN_STUDIO_01 ?? "change-esp-studio-01-token"
    }
  ];

  const devices = parseJsonEnv<DeviceSeed[]>("DEVICES_JSON") ?? [
    {
      id: "studio-01",
      name: "Studio 01",
      location: "Local principal",
      token: process.env.DEVICE_TOKEN_STUDIO_01 ?? "change-studio-01-token",
      profileIds: defaultProfileIds,
      wolGatewayId: "esp-studio-01"
    },
    {
      id: "studio-02",
      name: "Studio 02",
      location: "Segundo local",
      token: process.env.DEVICE_TOKEN_STUDIO_02 ?? "change-studio-02-token",
      profileIds: defaultProfileIds
    }
  ];

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
    wolGateways
  };
}
