import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const webRoot = path.dirname(fileURLToPath(import.meta.url));

/** Node + vite-node 专用配置：直接转换 SFC，不启动依赖预构建服务。 */
export default defineConfig({
  // Component tests must not import project .env credentials into their process.
  envDir: false,
  plugins: [vue()],
  resolve: {
    alias: { "@": path.resolve(webRoot, "src") },
  },
  optimizeDeps: { noDiscovery: true, include: [] },
});
