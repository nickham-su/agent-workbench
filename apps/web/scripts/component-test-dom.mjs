import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });
Object.defineProperties(globalThis, Object.fromEntries(Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  SVGElement: window.SVGElement,
  Node: window.Node,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
}).map(([key, value]) => [key, { value, configurable: true, writable: true }])));
