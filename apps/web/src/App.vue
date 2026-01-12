<template>
  <a-config-provider :theme="antdTheme" :locale="antdLocale">
    <div class="min-h-screen" :style="appStyle">
      <router-view />
    </div>
  </a-config-provider>
</template>

<script setup lang="ts">
import { theme } from "ant-design-vue";
import type { CSSProperties } from "vue";
import { computed, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import enUS from "ant-design-vue/es/locale/en_US";

const antdTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    borderRadius: 2,
    borderRadiusLG: 4,
    borderRadiusSM: 2,
    fontSize: 13
  }
} as const;
const { token } = theme.useToken();

const { locale } = useI18n();
const antdLocale = computed(() => (locale.value === "en-US" ? enUS : zhCN));

const appStyle = computed(
  () =>
    ({
      background: "var(--app-bg)",
      color: "var(--text-color)"
    }) satisfies CSSProperties
);

watchEffect(() => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  root.lang = locale.value || "zh-CN";
  root.style.colorScheme = "dark";

  root.style.setProperty("--app-bg", token.value.colorBgLayout);
  root.style.setProperty("--panel-bg", token.value.colorBgContainer);
  root.style.setProperty("--panel-bg-elevated", token.value.colorBgElevated);
  root.style.setProperty("--border-color", token.value.colorBorder);
  root.style.setProperty("--border-color-secondary", (token.value as any).colorBorderSecondary ?? token.value.colorBorder);
  root.style.setProperty("--text-color", token.value.colorText);
  root.style.setProperty("--text-secondary", token.value.colorTextSecondary);
  root.style.setProperty("--text-tertiary", token.value.colorTextTertiary);
  root.style.setProperty("--fill-secondary", token.value.colorFillSecondary);
  root.style.setProperty("--fill-tertiary", token.value.colorFillTertiary);
  root.style.setProperty("--hover-bg", token.value.colorFillTertiary);
  root.style.setProperty("--danger-color", token.value.colorError);
  root.style.setProperty("--success-color", (token.value as any).colorSuccess ?? token.value.colorPrimary);
  root.style.setProperty("--warning-color", (token.value as any).colorWarning ?? token.value.colorPrimary);
  root.style.setProperty("--info-color", (token.value as any).colorInfo ?? token.value.colorPrimary);
});
</script>
