import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

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

export type AgentConfig = {
  serverUrl: string;
  deviceId: string;
  deviceToken: string;
  browserProfilePath: string;
  headless: boolean;
  shutdownDryRun: boolean;
  actionMap: Record<string, string>;
};

function parseActionMap(): Record<string, string> {
  const value = process.env.ACTION_MAP_JSON;
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value) as Record<string, string>;
  } catch (error) {
    throw new Error(`ACTION_MAP_JSON invalido: ${(error as Error).message}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} obrigatorio. Cadastre o computador no painel e configure o agente.`);
  }
  return value;
}

export function loadConfig(): AgentConfig {
  const deviceId = requiredEnv("DEVICE_ID");

  return {
    serverUrl: process.env.SERVER_URL ?? "ws://localhost:3000/agent",
    deviceId,
    deviceToken: requiredEnv("DEVICE_TOKEN"),
    browserProfilePath: process.env.BROWSER_PROFILE_PATH ?? `.cache/browser/${deviceId}`,
    headless: process.env.HEADLESS === "true",
    shutdownDryRun: process.env.SHUTDOWN_DRY_RUN === "true",
    actionMap: parseActionMap()
  };
}
