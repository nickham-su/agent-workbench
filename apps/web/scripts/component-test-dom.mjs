import { Window } from "happy-dom";

const window = new Window({
  url: "http://localhost/",
  settings: {
    // Click tests exercise event semantics, not real pages or external networks.
    navigation: {
      disableMainFrameNavigation: true,
      disableChildFrameNavigation: true,
      disableChildPageNavigation: true,
      // Disabled navigation must not silently change the current page's URL.
      disableFallbackToSetURL: true,
    },
  },
});
Object.defineProperties(globalThis, Object.fromEntries(Object.entries({
  // Vue reads this global before mounting. Avoid its 3s late-DevTools timer
  // without changing development mode or application timers.
  __VUE_DEVTOOLS_GLOBAL_HOOK__: { emit() {}, on() {}, off() {} },
  window,
  document: window.document,
  navigator: window.navigator,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  ShadowRoot: window.ShadowRoot,
  SVGElement: window.SVGElement,
  Node: window.Node,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
}).map(([key, value]) => [key, { value, configurable: true, writable: true }])));

// Initialize Vue's cached DOM renderer without mounting an app. Remove the hook
// afterwards so Vue Test Utils can install its own event recorder, rather than
// repeatedly wrapping a persistent global hook on every mount.
const { createApp } = await import("vue");
createApp({ render: () => null });
delete globalThis.__VUE_DEVTOOLS_GLOBAL_HOOK__;
