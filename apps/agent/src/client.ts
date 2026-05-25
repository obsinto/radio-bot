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

    socket.on("unexpected-response", (_request, response) => {
      const contentType = String(response.headers["content-type"] ?? "");
      console.error(
        `[agent] falha WebSocket: servidor respondeu HTTP ${response.statusCode}${
          contentType ? ` (${contentType})` : ""
        }.`
      );

      if (response.statusCode === 200 && contentType.includes("text/html")) {
        console.error(
          "[agent] a SERVER_URL parece apontar para o painel web, nao para a API. Use a URL da API, por exemplo wss://api.seu-dominio.com/agent."
        );
      }
    });

    socket.on("close", (code, reason) => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (code === 1008) {
        console.error("[agent] credenciais recusadas pela API. Confira DEVICE_ID e DEVICE_TOKEN.");
      }
      const suffix = code ? ` (codigo ${code}${reason.length > 0 ? `, ${reason.toString()}` : ""})` : "";
      console.log(`[agent] desconectado${suffix}; tentando novamente em 5s`);
      setTimeout(connect, 5000);
    });

    socket.on("error", (error) => {
      console.error(`[agent] erro de conexao: ${error.message}`);
    });
  };

  connect();
}
