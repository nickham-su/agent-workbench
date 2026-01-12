import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const apiTarget = env.VITE_API_TARGET || `http://127.0.0.1:${env.API_PORT || env.PORT || 4310}`;

  return {
    envDir: repoRoot,
    plugins: [vue()],
    define: {
      __DEV_API_TARGET__: JSON.stringify(apiTarget)
    },
    server: {
      proxy: {
        "/api": {
          target: apiTarget,
          ws: true,
          changeOrigin: true
        }
      }
    }
  };
});
