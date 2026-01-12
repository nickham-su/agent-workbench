/// <reference types="vite/client" />

declare const __DEV_API_TARGET__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
