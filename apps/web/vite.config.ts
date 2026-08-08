import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Port and API target come from the environment so the E2E suite can run its
 * own isolated pair of servers without colliding with a running dev session.
 */
const port = Number(process.env["VITE_PORT"] ?? 5173);
const apiTarget = process.env["VITE_API_TARGET"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly. Left to default, Vite binds ::1 on Windows while
    // tooling connects to 127.0.0.1, and the connection is refused even though
    // a port check says the server is up.
    host: "127.0.0.1",
    port,
    strictPort: true,
    // The API is same-origin in production. Proxying in development keeps the
    // client free of environment-specific base URLs and avoids CORS entirely.
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // The chat socket lives at /api/v1/realtime. Without this the upgrade
        // request is not forwarded and realtime works in production but not in
        // development — the worst place for a difference to hide.
        ws: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
