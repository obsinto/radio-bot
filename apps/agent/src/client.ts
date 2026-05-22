import WebSocket from "ws";
import type {
  AgentToServerMessage,
  ServerToAgentMessage
} from "@radio-bot/shared";
import { BrowserController } from "./browser-controller.js";
import type { AgentConfig } from "./config.js";

function buildConnectionUrl(config: AgentConfig): string {
  const url = new URL(config.serverUrl);
  url.searchParams.set("deviceId", config.deviceId);
  url.searchParams.set("token", config.deviceToken);
  return url.toString();
}

function send(socket: WebSocket, message: AgentToServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parseMessage(raw: WebSocket.RawData): ServerToAgentMessage | null {
  try {
    return JSON.parse(raw.toString()) as ServerToAgentMessage;
  } catch {
    return null;
  }
}

export function startAgent(config: AgentConfig): void {
  const controller = new BrowserController(config);

  const connect = () => {
    const socket = new WebSocket(buildConnectionUrl(config));
    let heartbeat: NodeJS.Timeout | null = null;

    socket.on("open", () => {
      console.log(`[agent] conectado como ${config.deviceId}`);
      heartbeat = setInterval(async () => {
        send(socket, {
          type: "heartbeat",
          state: await controller.getState()
        });
      }, 10000);
    });

    socket.on("message", async (raw) => {
      const message = parseMessage(raw);
      if (!message) {
        return;
      }

      if (message.type === "registered") {
        send(socket, {
          type: "heartbeat",
          state: await controller.getState()
        });
        return;
      }

      if (message.type === "command") {
        console.log(`[agent] comando recebido: ${message.command.action} (${message.command.id})`);
        try {
          const result = await controller.execute(message.command, message.profile);
          console.log(`[agent] comando ${message.command.action} status=${result.status ?? "succeeded"}`);
          send(socket, {
            type: "command_result",
            commandId: message.command.id,
            status: result.status ?? "succeeded",
            output: result.output,
            screenshot: result.screenshot,
            state: result.state
          });
        } catch (error) {
          console.error(`[agent] comando ${message.command.action} FAILED: ${(error as Error).message}`);
          send(socket, {
            type: "command_result",
            commandId: message.command.id,
            status: "failed",
            error: (error as Error).message,
            state: await controller.getState()
          });
        }
      }
    });

    socket.on("close", () => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      console.log("[agent] desconectado; tentando novamente em 5s");
      setTimeout(connect, 5000);
    });

    socket.on("error", (error) => {
      console.error(`[agent] erro de conexao: ${error.message}`);
    });
  };

  connect();
}
