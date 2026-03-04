import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";

// 预加载 Monaco 的部分服务注册.
// 否则在某些增量加载/虚拟列表频繁挂载场景下,可能出现 UNKNOWN service (例如 treeViewsDndService)。
import "monaco-editor/esm/vs/editor/common/services/treeViewsDndService.js";
import "monaco-editor/esm/vs/editor/contrib/codelens/browser/codeLensCache.js";
import "monaco-editor/esm/vs/editor/contrib/documentSymbols/browser/outlineModel.js";
import "monaco-editor/esm/vs/platform/actionWidget/browser/actionWidget.js";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestMemory.js";
import "monaco-editor/esm/vs/editor/contrib/inlayHints/browser/inlayHintsController.js";

export function ensureMonacoEnvironment() {
  const g = globalThis as any;
  if (g.MonacoEnvironment) return;

  g.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === "json") return new JsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new CssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
      if (label === "typescript" || label === "javascript") return new TsWorker();
      return new EditorWorker();
    }
  };
}
