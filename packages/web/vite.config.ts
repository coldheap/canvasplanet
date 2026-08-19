import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Keep the dev server alive when the API restarts.
 *
 * http-proxy emits `error` on the proxy object, and an EventEmitter with no
 * `error` listener throws — which kills the whole Vite process. Every time
 * the API bounced (a tsx-watch reload, a Postgres restart), the browser's
 * WebSocket clients reconnected in a burst, each one hit a proxy that could
 * not reach :8080, and the dev server died with an unhandled ECONNREFUSED.
 * It looked like Vite crashing on its own; it was Vite faithfully rethrowing
 * the API's absence.
 *
 * Swallowing these is correct here: the client already reconnects with
 * backoff, so a failed proxy attempt during a restart is expected and
 * self-healing. One line per event keeps it visible without a stack trace
 * per reconnect.
 */
const surviveApiRestarts: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("error", (err) => {
    console.warn(`[proxy] ${err.message} — is the API on :8080 up?`);
  });
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind IPv4 explicitly. Vite's default "localhost" resolves to ::1 on
    // Windows, so http://127.0.0.1:5173 refuses the connection while
    // http://localhost:5173 works — a confusing split, and it does not match
    // the API, which binds 127.0.0.1.
    host: "127.0.0.1",
    // In dev the SPA is served by Vite and everything else by the API, so
    // proxy the three server-owned prefixes. In production Caddy does this.
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true, configure: surviveApiRestarts },
      "/tiles": { target: "http://localhost:8080", changeOrigin: true, configure: surviveApiRestarts },
      "/basemap": { target: "http://localhost:8080", changeOrigin: true, configure: surviveApiRestarts },
      "/ws": { target: "ws://localhost:8080", ws: true, configure: surviveApiRestarts },
    },
  },
  build: {
    outDir: "dist",
    // Local development already has Vite source mapping. Publishing maps in
    // production exposes the client source tree and adds several megabytes.
    sourcemap: false,
    rollupOptions: {
      // Vite's default build only emits index.html. embed.html (the
      // read-only widget, ROADMAP.md §4.2) is a deliberately separate entry
      // — see EmbedApp.tsx — so it has to be listed explicitly to ship in
      // the production build; dev already serves both without this.
      input: {
        main: resolve(__dirname, "index.html"),
        embed: resolve(__dirname, "embed.html"),
      },
    },
  },
});
