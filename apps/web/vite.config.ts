import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const allowedHosts = (process.env.VITE_ALLOWED_HOSTS ?? "radio.agilytech.com")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts
  },
  preview: {
    port: 4173,
    allowedHosts
  }
});
