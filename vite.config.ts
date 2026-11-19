import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { ocgcoreWasmStub } from "./src/worker/duel/engine/vitePlugin.ts";

// One Worker serves both the API (/api/*, /img/*, /ws/*) and the built React app.
export default defineConfig({
  // UX_SOURCEMAP=1 npm run build: source maps next to the bundle (not linked from it), so the UX audit can name
  // the source file and line behind a stutter (scripts/ux/audit.mjs). Off for normal / deploy builds.
  build: { sourcemap: process.env.UX_SOURCEMAP ? "hidden" : false },
  // ocgcoreWasmStub drops ocgcore-wasm's inlined base64 WASM copies (the Worker imports the .wasm module).
  // CF_INSPECTOR_PORT lets several dev servers run side by side (default debugger port is 9229);
  // CF_INSPECTOR_PORT=off disables the debugger.
  plugins: [
    ocgcoreWasmStub(),
    react(),
    cloudflare(
      process.env.CF_INSPECTOR_PORT
        ? { inspectorPort: process.env.CF_INSPECTOR_PORT === "off" ? false : Number(process.env.CF_INSPECTOR_PORT) }
        : {},
    ),
  ],
});
