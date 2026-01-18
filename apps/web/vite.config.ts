import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "../..");
const srcRoot = path.resolve(webRoot, "src");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const devApiOrigin = env.AWB_DEV_API_ORIGIN || `http://127.0.0.1:${env.AWB_PORT || 4310}`;

  const devWebPortRaw = env.AWB_DEV_WEB_PORT?.trim() || "";
  let devWebPort: number | undefined;
  if (devWebPortRaw) {
    const parsed = Number.parseInt(devWebPortRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid AWB_DEV_WEB_PORT: ${devWebPortRaw}`);
    }
    devWebPort = parsed;
  }

  return {
    envDir: repoRoot,
    plugins: [vue()],
    resolve: {
      alias: {
        "@": srcRoot
      }
    },
    define: {
      __DEV_API_TARGET__: JSON.stringify(devApiOrigin)
    },
    server: {
      // 允许局域网/外部设备访问（等价于监听 0.0.0.0）
      host: true,
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
