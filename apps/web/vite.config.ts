import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const devApiOrigin = env.DEV_API_ORIGIN || `http://127.0.0.1:${env.PORT || 4310}`;

  const devWebPortRaw = env.DEV_WEB_PORT?.trim() || "";
  let devWebPort: number | undefined;
  if (devWebPortRaw) {
    const parsed = Number.parseInt(devWebPortRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid DEV_WEB_PORT: ${devWebPortRaw}`);
    }
    devWebPort = parsed;
  }

  return {
    envDir: repoRoot,
    plugins: [vue()],
    define: {
      __DEV_API_TARGET__: JSON.stringify(devApiOrigin)
    },
    server: {
      port: devWebPort,
      proxy: {
        "/api": {
          target: devApiOrigin,
          ws: true,
          changeOrigin: true
        }
      }
    }
  };
});
