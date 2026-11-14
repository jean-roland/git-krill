import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { execSync } from "node:child_process";
const host = process.env.TAURI_DEV_HOST;
// which build this is, shown in Settings: a source tarball has no git to ask
const describe = () => {
  try {
    return execSync("git describe --tags --always --dirty", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

// https://vite.dev/config/
export default defineConfig(() => ({
  define: { __BUILD__: JSON.stringify({ id: describe(), time: Math.floor(Date.now() / 1000) }) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
