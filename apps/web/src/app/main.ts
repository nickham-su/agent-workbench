import { createApp } from "vue";
import Antd from "ant-design-vue";
import "ant-design-vue/dist/reset.css";
import "@xterm/xterm/css/xterm.css";
import "@/shared/styles/tailwind.css";
import App from "./App.vue";
import { router } from "./router";
import { i18n } from "@/shared/i18n";
import { onUnauthorized } from "@/features/auth/unauthorized";
import { resetAuthStatus } from "@/features/auth/session";

onUnauthorized(() => {
  resetAuthStatus();
  const next = router.currentRoute.value.fullPath;
  if (router.currentRoute.value.path !== "/") {
    void router.replace({ path: "/", query: next ? { next } : undefined });
  }
});

createApp(App).use(i18n).use(Antd).use(router).mount("#app");
