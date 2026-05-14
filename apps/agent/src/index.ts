import { loadConfig } from "./config.js";
import { startAgent } from "./client.js";

startAgent(loadConfig());
