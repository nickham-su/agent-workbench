import assert from "node:assert/strict";
import test from "node:test";
import {
  captureLosslessSnapshot,
  encodeLosslessValueGraph,
  type EncodedAccessorDescriptor,
  type EncodedNode,
  type EncodedOwnProperty,
  type ErrorSemanticObservation
} from "./losslessValueGraph.js";

function rootNode(graph: ReturnType<typeof encodeLosslessValueGraph>): EncodedNode {
  assert.equal(graph.root.type, "ref");
  const node = graph.nodes[graph.root.id];
  assert.ok(node);
  return node;
}

function property(node: EncodedNode, key: string): EncodedOwnProperty {
  const result = node.properties.find((item) => item.key.type === "string" && item.key.value === key);
  assert.ok(result, `missing property ${key}`);
  return result;
}

function dataValue(node: EncodedNode, key: string) {
  const descriptor = property(node, key).descriptor;
  assert.equal(descriptor.kind, "data");
  return descriptor.value;
}

function observationValue(observation: ErrorSemanticObservation) {
  assert.equal(observation.availability, "data");
  return observation.value;
}

test("编码 primitive、特殊 number、BigInt 和长字符串，不脱敏或截断", () => {
  const longText = "token=password=" + "x".repeat(9_500) + "\u0000\n结束";
  const graph = encodeLosslessValueGraph({
    nil: null,
    absent: undefined,
    yes: true,
    negativeZero: -0,
    nan: Number.NaN,
    positiveInfinity: Infinity,
    negativeInfinity: -Infinity,
    bigint: -123456789012345678901234567890n,
    longText
  });
  const node = rootNode(graph);

  assert.deepEqual(dataValue(node, "nil"), { type: "null" });
  assert.deepEqual(dataValue(node, "absent"), { type: "undefined" });
  assert.deepEqual(dataValue(node, "yes"), { type: "boolean", value: true });
  assert.deepEqual(dataValue(node, "negativeZero"), { type: "number", special: "negative_zero" });
  assert.deepEqual(dataValue(node, "nan"), { type: "number", special: "nan" });
  assert.deepEqual(dataValue(node, "positiveInfinity"), { type: "number", special: "positive_infinity" });
  assert.deepEqual(dataValue(node, "negativeInfinity"), { type: "number", special: "negative_infinity" });
  assert.deepEqual(dataValue(node, "bigint"), { type: "bigint", decimal: "-123456789012345678901234567890" });
  assert.deepEqual(dataValue(node, "longText"), { type: "string", value: longText });
  assert.doesNotThrow(() => JSON.stringify(graph));
});

test("保留循环、共享对象和共享 Symbol 的 ref 身份", () => {
  const shared = { answer: 42 };
  const symbol = Symbol.for("awb-fixture-symbol");
  const value: Record<PropertyKey, unknown> = { left: shared, right: shared, symbolA: symbol, symbolB: symbol };
  value.self = value;
  value[symbol] = value;

  const graph = encodeLosslessValueGraph(value);
  const root = rootNode(graph);
  const left = dataValue(root, "left");
  const right = dataValue(root, "right");
  const self = dataValue(root, "self");
  const symbolA = dataValue(root, "symbolA");
  const symbolB = dataValue(root, "symbolB");

  assert.equal(left.type, "ref");
  assert.deepEqual(right, left);
  assert.deepEqual(self, graph.root);
  assert.equal(symbolA.type, "ref");
  assert.deepEqual(symbolB, symbolA);
  assert.equal(graph.nodes[symbolA.id]?.kind, "symbol");
  assert.ok(root.properties.some((item) => item.key.type === "symbol" && item.key.value.type === "ref" && item.key.value.id === symbolA.id));
});

test("使用 descriptor-only 保存 data 属性与 accessor，且绝不执行 getter/toJSON/toString", () => {
  let getterCalls = 0;
  let toJsonCalls = 0;
  let toStringCalls = 0;
  const symbol = Symbol("secret-key");
  const value: Record<PropertyKey, unknown> = {
    visible: "token-value",
    toJSON() {
      toJsonCalls += 1;
      return {};
    },
    toString() {
      toStringCalls += 1;
      return "unexpected";
    }
  };
  Object.defineProperty(value, "hidden", { value: "full-secret", enumerable: false, configurable: false, writable: false });
  Object.defineProperty(value, "computed", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    },
    set(_next: unknown) {}
  });
  Object.defineProperty(value, Symbol.toStringTag, {
    get() {
      getterCalls += 1;
      return "NeverRead";
    }
  });
  value[symbol] = "symbol-value";

  const node = rootNode(encodeLosslessValueGraph(value));
  assert.equal(getterCalls, 0);
  assert.equal(toJsonCalls, 0);
  assert.equal(toStringCalls, 0);
  assert.deepEqual(dataValue(node, "visible"), { type: "string", value: "token-value" });
  const hidden = property(node, "hidden").descriptor;
  assert.deepEqual(hidden, {
    kind: "data",
    enumerable: false,
    configurable: false,
    writable: false,
    value: { type: "string", value: "full-secret" }
  });
  const accessor = property(node, "computed").descriptor;
  assert.equal(accessor.kind, "accessor");
  assert.equal(accessor.get.type, "ref");
  assert.equal(accessor.set.type, "ref");
  assert.ok(node.properties.some((item) => item.key.type === "symbol"));
});

test("Error 的语义字段按 data、unavailable_accessor、absent、reflection_error 表达", () => {
  const cause = { nested: "complete-result" };
  const error = new Error("full message", { cause });
  Object.defineProperty(error, "name", { value: "FixtureError", configurable: true });
  Object.defineProperty(error, "stack", {
    configurable: true,
    get() {
      throw new Error("stack getter must not execute");
    }
  });
  Object.defineProperty(error, "code", { value: "E_FIXTURE", enumerable: false });
  Object.defineProperty(error, "partialResult", { value: { stdout: "full stdout" }, enumerable: true });

  const node = rootNode(encodeLosslessValueGraph(error));
  assert.equal(node.kind, "error");
  assert.deepEqual(observationValue(node.errorName), { type: "string", value: "FixtureError" });
  assert.deepEqual(observationValue(node.message), { type: "string", value: "full message" });
  assert.equal(node.stack.availability, "unavailable_accessor");
  assert.equal(observationValue(node.cause).type, "ref");
  assert.equal(node.aggregateErrors.availability, "absent");
  assert.deepEqual(dataValue(node, "code"), { type: "string", value: "E_FIXTURE" });
  assert.equal(dataValue(node, "partialResult").type, "ref");

  const inheritedError = new Error("own message");
  delete (inheritedError as { name?: string }).name;
  const inheritedNode = rootNode(encodeLosslessValueGraph(inheritedError));
  assert.equal(inheritedNode.kind, "error");
  assert.equal(inheritedNode.errorName.availability, "data");
  if (inheritedNode.errorName.availability === "data") {
    assert.deepEqual(inheritedNode.errorName.owner, { prototypeDepth: 1 });
    assert.deepEqual(inheritedNode.errorName.value, { type: "string", value: "Error" });
  }
  assert.equal(inheritedNode.cause.availability, "absent");
  assert.equal(inheritedNode.aggregateErrors.availability, "absent");

  const reflected = new Proxy(new Error("reflect me"), {
    getOwnPropertyDescriptor(_target, key) {
      if (key === "message") throw new Error("message descriptor denied");
      return Reflect.getOwnPropertyDescriptor(_target, key);
    }
  });
  const reflectedNode = rootNode(encodeLosslessValueGraph(reflected));
  assert.equal(reflectedNode.kind, "error");
  assert.equal(reflectedNode.message.availability, "reflection_error");

  const aggregate = new AggregateError(["first", cause], "aggregate message");
  const aggregateNode = rootNode(encodeLosslessValueGraph(aggregate));
  assert.equal(aggregateNode.kind, "error");
  assert.equal(aggregateNode.aggregateErrors.availability, "data");
  assert.equal(aggregateNode.aggregateErrors.value.type, "ref");
});

test("Error 的自有 accessor 不被调用，且普通对象不会被伪装为 Error", () => {
  let calls = 0;
  const accessorError = new Error("message");
  Object.defineProperty(accessorError, "partialResult", {
    get() {
      calls += 1;
      return { shouldNot: "exist" };
    }
  });
  const accessorNode = rootNode(encodeLosslessValueGraph(accessorError));
  assert.equal(accessorNode.kind, "error");
  assert.equal(calls, 0);
  const descriptor = property(accessorNode, "partialResult").descriptor;
  assert.equal(descriptor.kind, "accessor");

  const prototype = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(prototype, "name", { value: "PrototypeName" });
  const inheritedError = Object.create(prototype) as Error;
  const inheritedNode = rootNode(encodeLosslessValueGraph(inheritedError));
  assert.notEqual(inheritedNode.kind, "error", "plain objects are not coerced to Error nodes");
});


test("内建对象保留可观察内容且不执行 Promise/WeakMap/WeakSet", () => {
  const buffer = Buffer.from([0, 1, 2, 255]);
  const raw = Uint8Array.from([7, 8, 9]).buffer;
  const typed = new Uint16Array([0x1234, 0xabcd]);
  const view = new DataView(raw);
  const mapKey = { map: "key" };
  const shared = { shared: true };
  const value = {
    date: new Date("2024-03-04T05:06:07.000Z"),
    invalidDate: new Date("invalid"),
    regexp: /a+b/gi,
    map: new Map([[mapKey, shared]]),
    set: new Set([shared]),
    buffer,
    raw,
    typed,
    view,
    url: new URL("https://example.test/a?b=c"),
    params: new URLSearchParams("b=c&d=e"),
    weakMap: new WeakMap([[mapKey, shared]]),
    weakSet: new WeakSet([shared]),
    promise: Promise.resolve("never observed")
  };
  value.regexp.lastIndex = 2;

  const graph = encodeLosslessValueGraph(value);
  const root = rootNode(graph);
  const nodeFor = (name: string) => {
    const reference = dataValue(root, name);
    assert.equal(reference.type, "ref");
    const node = graph.nodes[reference.id];
    assert.ok(node);
    return node;
  };

  assert.deepEqual(nodeFor("date"), {
    kind: "date",
    tag: "[object Date]",
    properties: [],
    timeValue: Date.parse("2024-03-04T05:06:07.000Z")
  });
  assert.equal(nodeFor("invalidDate").kind, "date");
  assert.deepEqual((nodeFor("invalidDate") as any).timeValue, { special: "invalid_date" });
  const regexp = nodeFor("regexp");
  assert.equal(regexp.kind, "regexp");
  assert.equal(regexp.source, "a+b");
  assert.equal(regexp.flags, "gi");
  assert.deepEqual(regexp.lastIndex, { type: "number", value: 2 });
  const map = nodeFor("map");
  assert.equal(map.kind, "map");
  assert.equal(map.entries?.length, 1);
  const set = nodeFor("set");
  assert.equal(set.kind, "set");
  assert.equal(set.values?.length, 1);
  const bufferNode = nodeFor("buffer");
  assert.equal(bufferNode.kind, "buffer");
  assert.equal(bufferNode.bytes, buffer.toString("base64"));
  const rawNode = nodeFor("raw");
  assert.equal(rawNode.kind, "array_buffer");
  assert.equal(rawNode.bytes, Buffer.from(raw).toString("base64"));
  const typedNode = nodeFor("typed");
  assert.equal(typedNode.kind, "typed_array");
  assert.equal(typedNode.bytes, Buffer.from(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)).toString("base64"));
  assert.equal(typedNode.properties.some((item) => item.key.type === "string" && item.key.value === "0"), false);
  assert.equal(bufferNode.properties.some((item) => item.key.type === "string" && item.key.value === "0"), false);
  assert.equal(nodeFor("view").kind, "data_view");
  assert.deepEqual((nodeFor("weakMap") as any).contentsObservable, false);
  assert.deepEqual((nodeFor("weakSet") as any).contentsObservable, false);
  assert.deepEqual((nodeFor("promise") as any).stateObservable, false);
});

test("Function 使用内建 intrinsic 获取 source 而不执行函数", () => {
  let calls = 0;
  let customToStringCalls = 0;
  function fixtureFunction(_value: unknown) {
    calls += 1;
    return "not executed";
  }
  Object.defineProperty(fixtureFunction, "toString", {
    value() {
      customToStringCalls += 1;
      return "custom source must not be used";
    }
  });
  const graph = encodeLosslessValueGraph(fixtureFunction);
  const node = rootNode(graph);
  assert.equal(node.kind, "function");
  assert.equal(node.name, "fixtureFunction");
  assert.equal(node.length, 1);
  assert.match(node.source ?? "", /function fixtureFunction/);
  assert.equal(calls, 0);
  assert.equal(customToStringCalls, 0);
});

test("Proxy 反射失败局部降级为 reflection_error", () => {
  const proxy = new Proxy({}, {
    ownKeys() {
      throw new Error("own keys denied");
    },
    getPrototypeOf() {
      throw new Error("prototype denied");
    }
  });
  const node = rootNode(encodeLosslessValueGraph(proxy));
  assert.ok(node.reflectionErrors?.some((item) => item.kind === "reflection_error" && item.operation === "own_keys"));
  assert.ok(node.reflectionErrors?.some((item) => item.kind === "reflection_error" && item.operation === "get_prototype_of"));
  assert.doesNotThrow(() => JSON.stringify(node));
});

test("2000 层对象链通过显式 work queue 完成且快照与后续修改隔离", () => {
  const root: { level: number; next?: { level: number; next?: unknown } } = { level: 0 };
  let cursor = root;
  for (let level = 1; level <= 2_000; level += 1) {
    const next = { level };
    cursor.next = next;
    cursor = next;
  }

  const snapshot = captureLosslessSnapshot(root, 1234);
  root.level = 99;
  const first = rootNode(snapshot.graph);
  assert.deepEqual(dataValue(first, "level"), { type: "number", value: 0 });
  assert.equal(Object.keys(snapshot.graph.nodes).length, 2_001);
  assert.equal(snapshot.capturedAt, 1234);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});
