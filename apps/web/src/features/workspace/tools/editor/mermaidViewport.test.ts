import assert from "node:assert/strict";
import test from "node:test";
import { clampMermaidScale, fitMermaidScale, getMermaidSvgSize, isMermaidViewportState, zoomMermaidViewport, MERMAID_MAX_SCALE } from "./mermaidViewport";

test("SVG 尺寸优先采用 viewBox，支持非零原点、百分比宽度和逗号", () => {
  assert.deepEqual(getMermaidSvgSize("-20, -30, 640, 480", "100%", null), { width: 640, height: 480 });
  assert.deepEqual(getMermaidSvgSize("0 0 1e3 2e2", null, null), { width: 1000, height: 200 });
  assert.deepEqual(getMermaidSvgSize(null, "640px", "480"), { width: 640, height: 480 });
  assert.deepEqual(getMermaidSvgSize(null, "100%", null, { width: 320, height: 240 }), { width: 320, height: 240 });
});
test("无效、非有限和零尺寸不产生缩放画布", () => {
  for (const box of ["0 0 0 10", "0 0 10 -1", "0 0 Infinity 20", "0 0 10", "a b c d"]) {
    assert.equal(getMermaidSvgSize(box, "100%", null), null);
  }
  assert.equal(getMermaidSvgSize(null, "-1", "20"), null);
  assert.equal(getMermaidSvgSize(null, "10foo", "20"), null);
  assert.equal(getMermaidSvgSize(null, null, null, { width: 0, height: 2 }), null);
});
test("适应窗口预留操作区且不放大小图，超大图也能完整适应", () => {
  assert.equal(fitMermaidScale({ width: 100, height: 100 }, 800, 600), 1);
  assert.equal(fitMermaidScale({ width: 1000, height: 500 }, 596, 532), 0.5);
  const fit = fitMermaidScale({ width: 100_000, height: 500 }, 596, 532);
  assert.equal(fit, 0.005);
  assert.equal(clampMermaidScale(0, fit), fit);
  assert.equal(fitMermaidScale({ width: 100, height: 100 }, 0, 0), 1);
});
test("缩放比例有上下界并防御无效保存状态", () => {
  assert.equal(clampMermaidScale(100, 0.5), MERMAID_MAX_SCALE);
  assert.equal(clampMermaidScale(0.001, 0.5), 0.05);
  assert.equal(clampMermaidScale(NaN, 0.5), 1);
  const state = { scale: 2, left: 100, top: 50, contentRevision: 7 };
  assert.ok(isMermaidViewportState(state, 7));
  assert.equal(isMermaidViewportState(state, 8), false);
  for (const invalid of [{ scale: NaN }, { scale: 0 }, { left: -1 }, { top: Infinity }]) {
    assert.equal(isMermaidViewportState({ ...state, ...invalid }, 7), false);
  }
});
test("鼠标锚点缩放考虑画布边距，往返缩放保持同一图中位置", () => {
  const current = { scale: 1, left: 200, top: 100 };
  const anchor = { x: 120, y: 80 };
  const next = zoomMermaidViewport(current, 2, anchor);
  assert.deepEqual(next, { left: 504, top: 264 });
  assert.deepEqual(zoomMermaidViewport({ scale: 2, ...next }, 1, anchor), { left: 200, top: 100 });
  assert.deepEqual(zoomMermaidViewport({ scale: 1, left: 0, top: 0 }, 0.1, anchor), { left: 0, top: 0 });
});
