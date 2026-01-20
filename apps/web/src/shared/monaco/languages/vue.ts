import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { conf as cssConf, language as cssLanguage } from "monaco-editor/esm/vs/basic-languages/css/css.js";
import { conf as htmlConf, language as htmlLanguage } from "monaco-editor/esm/vs/basic-languages/html/html.js";
import { conf as javascriptConf, language as javascriptLanguage } from "monaco-editor/esm/vs/basic-languages/javascript/javascript.js";
import { conf as typescriptConf, language as typescriptLanguage } from "monaco-editor/esm/vs/basic-languages/typescript/typescript.js";

let registered = false;
const VUE_JS_ID = "vue-javascript";
const VUE_TS_ID = "vue-typescript";
const VUE_CSS_ID = "vue-css";

export function registerVueLanguage() {
  if (registered) return;
  const exists = monaco.languages.getLanguages().some((lang) => lang.id === "vue");
  if (!exists) {
    registerEmbeddedLanguages();
    const language = buildVueLanguage();
    monaco.languages.register({ id: "vue", extensions: [".vue"], aliases: ["Vue", "vue"] });
    monaco.languages.setMonarchTokensProvider("vue", language);
    monaco.languages.setLanguageConfiguration("vue", htmlConf);
  }
  registered = true;
}

function buildVueLanguage(): monaco.languages.IMonarchLanguage {
  const html = htmlLanguage as monaco.languages.IMonarchLanguage;
  const rawTokenizer = (html.tokenizer ?? {}) as Record<string, any[]>;
  const embeddedMap = {
    "text/javascript": VUE_JS_ID,
    "text/css": VUE_CSS_ID
  };
  const tokenizer: Record<string, any[]> = {
    ...rawTokenizer,
    script: patchEmbeddedLanguages(rawTokenizer.script ?? [], embeddedMap),
    scriptAfterType: patchEmbeddedLanguages(rawTokenizer.scriptAfterType ?? [], embeddedMap),
    scriptAfterTypeEquals: patchEmbeddedLanguages(rawTokenizer.scriptAfterTypeEquals ?? [], embeddedMap),
    style: patchEmbeddedLanguages(rawTokenizer.style ?? [], embeddedMap),
    styleAfterType: patchEmbeddedLanguages(rawTokenizer.styleAfterType ?? [], embeddedMap),
    styleAfterTypeEquals: patchEmbeddedLanguages(rawTokenizer.styleAfterTypeEquals ?? [], embeddedMap)
  };

  const root = tweakRoot(tokenizer.root ?? []);
  const script = insertLangRule(tokenizer.script ?? [], "@scriptAfterLang");
  const style = insertLangRule(tokenizer.style ?? [], "@styleAfterLang");

  const vueTokenizer = {
    ...tokenizer,
    root,
    script,
    style,
    vueExpression: [
      [/\}\}/, { token: "delimiter.curly", next: "@pop" }],
      [/[^}]+/, "identifier"],
      [/./, "identifier"]
    ],
    scriptAfterLang: [
      [/=/, "delimiter", "@scriptAfterLangEquals"],
      [
        />/,
        {
          token: "delimiter",
          next: "@scriptEmbedded",
          nextEmbedded: VUE_JS_ID
        }
      ],
      [/[ \t\r\n]+/],
      [/<\/script\s*>/, { token: "@rematch", next: "@pop" }]
    ],
    scriptAfterLangEquals: buildScriptLangEquals(),
    styleAfterLang: [
      [/=/, "delimiter", "@styleAfterLangEquals"],
      [
        />/,
        {
          token: "delimiter",
          next: "@styleEmbedded",
          nextEmbedded: VUE_CSS_ID
        }
      ],
      [/[ \t\r\n]+/],
      [/<\/style\s*>/, { token: "@rematch", next: "@pop" }]
    ],
    styleAfterLangEquals: buildStyleLangEquals()
  };

  return { ...html, tokenPostfix: ".vue", tokenizer: vueTokenizer };
}

function registerEmbeddedLanguages() {
  registerEmbeddedLanguage(VUE_JS_ID, javascriptConf, javascriptLanguage, ["Vue JavaScript", "vue-javascript"]);
  registerEmbeddedLanguage(VUE_TS_ID, typescriptConf, typescriptLanguage, ["Vue TypeScript", "vue-typescript"]);
  registerEmbeddedLanguage(VUE_CSS_ID, cssConf, cssLanguage, ["Vue CSS", "vue-css"]);
}

function registerEmbeddedLanguage(id: string, conf: monaco.languages.LanguageConfiguration, language: monaco.languages.IMonarchLanguage, aliases: string[]) {
  const exists = monaco.languages.getLanguages().some((lang) => lang.id === id);
  if (exists) return;
  monaco.languages.register({ id, aliases });
  monaco.languages.setMonarchTokensProvider(id, language);
  monaco.languages.setLanguageConfiguration(id, conf);
}

function tweakRoot(rules: any[]) {
  const next: any[] = [];
  let injected = false;
  for (const rule of rules) {
    if (Array.isArray(rule) && rule[0] instanceof RegExp && rule[0].source === "[^<]+") {
      next.push([/\{\{/, { token: "delimiter.curly", next: "@vueExpression" }]);
      next.push([/[^<{]+/]);
      next.push([/\{/, "delimiter.curly"]);
      injected = true;
      continue;
    }
    next.push(rule);
  }
  if (!injected) {
    next.push([/\{\{/, { token: "delimiter.curly", next: "@vueExpression" }]);
    next.push([/[^<{]+/]);
    next.push([/\{/, "delimiter.curly"]);
  }
  return next;
}

function patchEmbeddedLanguages(rules: any[], map: Record<string, string>) {
  return rules.map((rule) => {
    if (!Array.isArray(rule)) return rule;
    let changed = false;
    const next = rule.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (!("nextEmbedded" in part)) return part;
      const value = (part as any).nextEmbedded;
      if (typeof value !== "string") return part;
      const mapped = map[value];
      if (!mapped) return part;
      changed = true;
      return { ...part, nextEmbedded: mapped };
    });
    return changed ? next : rule;
  });
}

function insertLangRule(rules: any[], nextState: string) {
  const next: any[] = [];
  let inserted = false;
  for (const rule of rules) {
    if (!inserted && Array.isArray(rule) && rule[0] instanceof RegExp && rule[0].source === "type") {
      next.push([/lang/, "attribute.name", nextState]);
      inserted = true;
    }
    next.push(rule);
  }
  if (!inserted) next.unshift([/lang/, "attribute.name", nextState]);
  return next;
}

function buildScriptLangEquals() {
  const rules: any[] = [];
  const map: Record<string, string> = {
    ts: VUE_TS_ID,
    tsx: VUE_TS_ID,
    js: VUE_JS_ID,
    jsx: VUE_JS_ID,
    typescript: VUE_TS_ID,
    javascript: VUE_JS_ID
  };

  for (const [key, lang] of Object.entries(map)) {
    rules.push([new RegExp(`"${key}"`), { token: "attribute.value", switchTo: `@scriptWithCustomType.${lang}` }]);
    rules.push([new RegExp(`'${key}'`), { token: "attribute.value", switchTo: `@scriptWithCustomType.${lang}` }]);
  }

  rules.push([/"([^"]*)"/, { token: "attribute.value", switchTo: `@scriptWithCustomType.${VUE_JS_ID}` }]);
  rules.push([/'([^']*)'/, { token: "attribute.value", switchTo: `@scriptWithCustomType.${VUE_JS_ID}` }]);
  rules.push([
    />/,
    {
      token: "delimiter",
      next: "@scriptEmbedded",
      nextEmbedded: VUE_JS_ID
    }
  ]);
  rules.push([/[ \t\r\n]+/]);
  rules.push([/<\/script\s*>/, { token: "@rematch", next: "@pop" }]);
  return rules;
}

function buildStyleLangEquals() {
  const rules: any[] = [];
  const map: Record<string, string> = {
    css: VUE_CSS_ID,
    scss: VUE_CSS_ID,
    sass: VUE_CSS_ID,
    less: VUE_CSS_ID,
    postcss: VUE_CSS_ID,
    styl: VUE_CSS_ID,
    stylus: VUE_CSS_ID
  };

  for (const [key, lang] of Object.entries(map)) {
    rules.push([new RegExp(`"${key}"`), { token: "attribute.value", switchTo: `@styleWithCustomType.${lang}` }]);
    rules.push([new RegExp(`'${key}'`), { token: "attribute.value", switchTo: `@styleWithCustomType.${lang}` }]);
  }

  rules.push([/"([^"]*)"/, { token: "attribute.value", switchTo: `@styleWithCustomType.${VUE_CSS_ID}` }]);
  rules.push([/'([^']*)'/, { token: "attribute.value", switchTo: `@styleWithCustomType.${VUE_CSS_ID}` }]);
  rules.push([
    />/,
    {
      token: "delimiter",
      next: "@styleEmbedded",
      nextEmbedded: VUE_CSS_ID
    }
  ]);
  rules.push([/[ \t\r\n]+/]);
  rules.push([/<\/style\s*>/, { token: "@rematch", next: "@pop" }]);
  return rules;
}
