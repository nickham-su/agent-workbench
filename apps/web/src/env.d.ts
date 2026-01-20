/// <reference types="vite/client" />

declare const __DEV_API_TARGET__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "monaco-editor/esm/vs/basic-languages/css/css.js";
declare module "monaco-editor/esm/vs/basic-languages/html/html.js";
declare module "monaco-editor/esm/vs/basic-languages/javascript/javascript.js";
declare module "monaco-editor/esm/vs/basic-languages/typescript/typescript.js";
