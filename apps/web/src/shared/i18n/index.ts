import { createI18n } from "vue-i18n";
import { getInitialLocale } from "./locale";
import zhCN from "./locales/zh-CN";
import enUS from "./locales/en-US";

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: getInitialLocale(),
  fallbackLocale: "zh-CN",
  messages: {
    "zh-CN": zhCN,
    "en-US": enUS
  }
});

