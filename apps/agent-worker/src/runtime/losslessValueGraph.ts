export type EncodedValue =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "number"; special: "negative_zero" | "nan" | "positive_infinity" | "negative_infinity" }
  | { type: "bigint"; decimal: string }
  | { type: "ref"; id: string }
  | { type: "absent" };

export type EncodedPropertyKey =
  | { type: "string"; value: string }
  | { type: "symbol"; value: EncodedValue };

export type EncodedDataDescriptor = {
  kind: "data";
  enumerable: boolean;
  configurable: boolean;
  writable: boolean;
  value: EncodedValue;
};

export type EncodedAccessorDescriptor = {
  kind: "accessor";
  enumerable: boolean;
  configurable: boolean;
  get: EncodedValue;
  set: EncodedValue;
};

export type EncodedOwnProperty = {
  key: EncodedPropertyKey;
  descriptor: EncodedDataDescriptor | EncodedAccessorDescriptor;
};

export type ReflectionError = {
  kind: "reflection_error";
  operation: "get_own_property_descriptors" | "own_keys" | "get_own_property_descriptor" | "get_prototype_of" | "builtin_observation" | "function_to_string";
  propertyKey?: EncodedPropertyKey;
  thrown: EncodedValue;
};

export type ErrorSemanticObservation =
  | {
      availability: "data";
      owner: "own" | { prototypeDepth: number };
      descriptor: EncodedDataDescriptor;
      value: EncodedValue;
    }
  | {
      availability: "unavailable_accessor";
      owner: "own" | { prototypeDepth: number };
      descriptor: EncodedAccessorDescriptor;
    }
  | { availability: "absent" }
  | { availability: "reflection_error"; error: ReflectionError };

type NodeBase = {
  tag: string;
  properties: EncodedOwnProperty[];
  reflectionErrors?: ReflectionError[];
};

export type EncodedNode =
  | (NodeBase & {
      kind: "object" | "array" | "class_instance";
      constructorName?: string;
      extensible?: boolean;
      sealed?: boolean;
      frozen?: boolean;
    })
  | (NodeBase & {
      kind: "error";
      errorName: ErrorSemanticObservation;
      message: ErrorSemanticObservation;
      stack: ErrorSemanticObservation;
      cause: ErrorSemanticObservation;
      aggregateErrors: ErrorSemanticObservation;
    })
  | (NodeBase & { kind: "function"; name?: string; length?: number; source?: string })
  | (NodeBase & { kind: "symbol"; globalKey?: string; description?: string })
  | (NodeBase & { kind: "date"; timeValue: number | { special: "invalid_date" } })
  | (NodeBase & { kind: "regexp"; source?: string; flags?: string; lastIndex?: EncodedValue })
  | (NodeBase & { kind: "map"; entries?: Array<{ key: EncodedValue; value: EncodedValue }> })
  | (NodeBase & { kind: "set"; values?: EncodedValue[] })
  | (NodeBase & { kind: "array_buffer" | "shared_array_buffer"; byteLength?: number; bytes?: string })
  | (NodeBase & {
      kind: "typed_array" | "data_view" | "buffer";
      constructorName?: string;
      byteOffset?: number;
      byteLength?: number;
      length?: number;
      bytes?: string;
    })
  | (NodeBase & { kind: "url" | "url_search_params"; value?: string })
  | (NodeBase & { kind: "weak_map" | "weak_set"; contentsObservable: false })
  | (NodeBase & { kind: "promise"; stateObservable: false });

export type LosslessValueGraphV1 = {
  format: "awb-lossless-value-graph";
  version: 1;
  root: EncodedValue;
  nodes: Record<string, EncodedNode>;
};

export type LosslessSnapshot = {
  capturedAt: number;
  graph: LosslessValueGraphV1;
};

type ReferenceValue = object | symbol | ((...args: never[]) => unknown);
type Descriptor = PropertyDescriptor;

/**
 * 将运行时已持有的 JavaScript 值转换为可 JSON.stringify 的保真对象图。
 *
 * 属性采集严格基于 descriptor：不会读取普通属性值，也不会执行 getter、
 * toJSON 或自定义 toString。内建对象的可观察状态只通过相应内建 intrinsic
 * 取得；所有反射/内建观察失败均局部编码为 reflection_error。
 */
export function encodeLosslessValueGraph(value: unknown): LosslessValueGraphV1 {
  const nodes: Record<string, EncodedNode> = {};
  const objectIds = new WeakMap<object, string>();
  const symbolIds = new Map<symbol, string>();
  const pending: Array<{ id: string; value: ReferenceValue }> = [];
  let nextId = 1;

  const allocateReference = (reference: ReferenceValue): EncodedValue => {
    const isSymbol = typeof reference === "symbol";
    const existingId = isSymbol
      ? symbolIds.get(reference as symbol)
      : objectIds.get(reference as object);
    if (existingId) return { type: "ref", id: existingId };

    const id = String(nextId++);
    if (isSymbol) symbolIds.set(reference as symbol, id);
    else objectIds.set(reference as object, id);
    pending.push({ id, value: reference });
    return { type: "ref", id };
  };

  const encodeValue = (raw: unknown): EncodedValue => {
    if (raw === null) return { type: "null" };
    switch (typeof raw) {
      case "undefined":
        return { type: "undefined" };
      case "boolean":
        return { type: "boolean", value: raw };
      case "string":
        return { type: "string", value: raw };
      case "number":
        if (Object.is(raw, -0)) return { type: "number", special: "negative_zero" };
        if (Number.isNaN(raw)) return { type: "number", special: "nan" };
        if (raw === Infinity) return { type: "number", special: "positive_infinity" };
        if (raw === -Infinity) return { type: "number", special: "negative_infinity" };
        return { type: "number", value: raw };
      case "bigint":
        return { type: "bigint", decimal: raw.toString(10) };
      case "symbol":
        return allocateReference(raw);
      case "function":
        return allocateReference(raw as (...args: never[]) => unknown);
      case "object":
        return allocateReference(raw as object);
      default:
        return { type: "undefined" };
    }
  };

  const encodeKey = (key: PropertyKey): EncodedPropertyKey => {
    if (typeof key === "string") return { type: "string", value: key };
    return { type: "symbol", value: encodeValue(key) };
  };

  const encodeDescriptor = (descriptor: Descriptor): EncodedDataDescriptor | EncodedAccessorDescriptor => {
    if (Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return {
        kind: "data",
        enumerable: Boolean(descriptor.enumerable),
        configurable: Boolean(descriptor.configurable),
        writable: Boolean(descriptor.writable),
        value: encodeValue(descriptor.value)
      };
    }
    return {
      kind: "accessor",
      enumerable: Boolean(descriptor.enumerable),
      configurable: Boolean(descriptor.configurable),
      get: descriptor.get === undefined ? { type: "absent" } : encodeValue(descriptor.get),
      set: descriptor.set === undefined ? { type: "absent" } : encodeValue(descriptor.set)
    };
  };

  const encodeThrown = (thrown: unknown): EncodedValue => encodeValue(thrown);

  const addReflectionError = (
    errors: ReflectionError[],
    operation: ReflectionError["operation"],
    thrown: unknown,
    propertyKey?: PropertyKey
  ): ReflectionError => {
    const error: ReflectionError = {
      kind: "reflection_error",
      operation,
      ...(propertyKey === undefined ? {} : { propertyKey: encodeKey(propertyKey) }),
      thrown: encodeThrown(thrown)
    };
    errors.push(error);
    return error;
  };

  const isArrayIndexKey = (key: PropertyKey) =>
    typeof key === "string"
    && /^(0|[1-9][0-9]*)$/.test(key)
    && Number.isSafeInteger(Number(key))
    && Number(key) < 4_294_967_295;

  const collectOwnProperties = (
    target: object,
    reflectionErrors: ReflectionError[],
    options: { excludeArrayIndexes?: boolean } = {}
  ): EncodedOwnProperty[] => {
    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(target);
    } catch (error) {
      addReflectionError(reflectionErrors, "own_keys", error);
      return [];
    }

    const properties: EncodedOwnProperty[] = [];
    for (const key of keys) {
      if (options.excludeArrayIndexes && isArrayIndexKey(key)) continue;
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (!descriptor) continue;
        properties.push({ key: encodeKey(key), descriptor: encodeDescriptor(descriptor) });
      } catch (error) {
        addReflectionError(reflectionErrors, "get_own_property_descriptor", error, key);
      }
    }
    return properties;
  };

  const getPrototype = (target: object, reflectionErrors: ReflectionError[]): object | null | undefined => {
    try {
      return Reflect.getPrototypeOf(target);
    } catch (error) {
      addReflectionError(reflectionErrors, "get_prototype_of", error);
      return undefined;
    }
  };

  const getConstructorName = (target: object, reflectionErrors: ReflectionError[]): string | undefined => {
    const prototype = getPrototype(target, reflectionErrors);
    if (!prototype) return undefined;
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(prototype, "constructor");
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return undefined;
      const nameDescriptor = Reflect.getOwnPropertyDescriptor(descriptor.value, "name");
      return nameDescriptor && "value" in nameDescriptor && typeof nameDescriptor.value === "string"
        ? nameDescriptor.value
        : undefined;
    } catch (error) {
      addReflectionError(reflectionErrors, "get_own_property_descriptor", error, "constructor");
      return undefined;
    }
  };

  const readObjectState = (target: object, reflectionErrors: ReflectionError[]) => {
    const read = (operation: () => boolean): boolean | undefined => {
      try {
        return operation();
      } catch (error) {
        addReflectionError(reflectionErrors, "builtin_observation", error);
        return undefined;
      }
    };
    return {
      extensible: read(() => Object.isExtensible(target)),
      sealed: read(() => Object.isSealed(target)),
      frozen: read(() => Object.isFrozen(target))
    };
  };

  const isInstance = (target: object, constructor: Function): boolean => {
    try {
      return target instanceof (constructor as any);
    } catch {
      return false;
    }
  };

  const isAggregateError = (target: object) => typeof AggregateError !== "undefined" && isInstance(target, AggregateError);
  const isError = (target: object) => isInstance(target, Error) || isAggregateError(target);

  const isBuffer = (target: object, reflectionErrors: ReflectionError[]): boolean => {
    try {
      return Buffer.isBuffer(target);
    } catch (error) {
      addReflectionError(reflectionErrors, "builtin_observation", error);
      return false;
    }
  };

  const observeErrorField = (target: object, field: string, reflectionErrors: ReflectionError[]): ErrorSemanticObservation => {
    let current: object | null = target;
    let prototypeDepth = 0;
    while (current) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(current, field);
      } catch (error) {
        return { availability: "reflection_error", error: addReflectionError(reflectionErrors, "get_own_property_descriptor", error, field) };
      }
      if (descriptor) {
        const owner: "own" | { prototypeDepth: number } = prototypeDepth === 0 ? "own" : { prototypeDepth };
        const encoded = encodeDescriptor(descriptor);
        if (encoded.kind === "data") {
          return { availability: "data", owner, descriptor: encoded, value: encoded.value };
        }
        return { availability: "unavailable_accessor", owner, descriptor: encoded };
      }
      try {
        current = Reflect.getPrototypeOf(current);
      } catch (error) {
        return { availability: "reflection_error", error: addReflectionError(reflectionErrors, "get_prototype_of", error) };
      }
      prototypeDepth += 1;
    }
    return { availability: "absent" };
  };

  const readOwnDataDescriptor = (target: object, key: PropertyKey): PropertyDescriptor | undefined => {
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return descriptor && "value" in descriptor ? descriptor : undefined;
    } catch {
      return undefined;
    }
  };

  const readIntrinsic = <T>(read: () => T, reflectionErrors: ReflectionError[]): T | undefined => {
    try {
      return read();
    } catch (error) {
      addReflectionError(reflectionErrors, "builtin_observation", error);
      return undefined;
    }
  };

  const baseNode = (target: object, reflectionErrors: ReflectionError[]): NodeBase => ({
    tag: Array.isArray(target) ? "[object Array]" : "[object Object]",
    properties: collectOwnProperties(target, reflectionErrors),
    ...(reflectionErrors.length ? { reflectionErrors } : {})
  });

  const encodeSymbolNode = (symbol: symbol): EncodedNode => {
    const reflectionErrors: ReflectionError[] = [];
    let globalKey: string | undefined;
    let description: string | undefined;
    try {
      globalKey = Symbol.keyFor(symbol);
    } catch (error) {
      addReflectionError(reflectionErrors, "builtin_observation", error);
    }
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(Symbol.prototype, "description");
      if (descriptor && typeof descriptor.get === "function") {
        const observed = descriptor.get.call(symbol);
        if (typeof observed === "string") description = observed;
      }
    } catch (error) {
      addReflectionError(reflectionErrors, "builtin_observation", error);
    }
    return {
      kind: "symbol",
      tag: "[object Symbol]",
      properties: [],
      ...(globalKey === undefined ? {} : { globalKey }),
      ...(description === undefined ? {} : { description }),
      ...(reflectionErrors.length ? { reflectionErrors } : {})
    };
  };

  const encodeFunctionNode = (fn: (...args: never[]) => unknown): EncodedNode => {
    const reflectionErrors: ReflectionError[] = [];
    const properties = collectOwnProperties(fn, reflectionErrors);
    const nameDescriptor = readOwnDataDescriptor(fn, "name");
    const lengthDescriptor = readOwnDataDescriptor(fn, "length");
    const source = readIntrinsic(() => Function.prototype.toString.call(fn), reflectionErrors);
    return {
      kind: "function",
      tag: "[object Function]",
      properties,
      ...(nameDescriptor && typeof nameDescriptor.value === "string" ? { name: nameDescriptor.value } : {}),
      ...(lengthDescriptor && typeof lengthDescriptor.value === "number" ? { length: lengthDescriptor.value } : {}),
      ...(typeof source === "string" ? { source } : {}),
      ...(reflectionErrors.length ? { reflectionErrors } : {})
    };
  };

  const encodeObjectNode = (target: object): EncodedNode => {
    const reflectionErrors: ReflectionError[] = [];

    if (isError(target)) {
      const node: EncodedNode = {
        kind: "error",
        tag: "[object Error]",
        properties: collectOwnProperties(target, reflectionErrors),
        errorName: observeErrorField(target, "name", reflectionErrors),
        message: observeErrorField(target, "message", reflectionErrors),
        stack: observeErrorField(target, "stack", reflectionErrors),
        cause: observeErrorField(target, "cause", reflectionErrors),
        aggregateErrors: observeErrorField(target, "errors", reflectionErrors)
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (Array.isArray(target)) {
      const state = readObjectState(target, reflectionErrors);
      const node: EncodedNode = {
        kind: "array",
        tag: "[object Array]",
        properties: collectOwnProperties(target, reflectionErrors),
        ...state
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isInstance(target, Date)) {
      const timeValue = readIntrinsic(() => Date.prototype.getTime.call(target), reflectionErrors);
      const node: EncodedNode = {
        kind: "date",
        tag: "[object Date]",
        properties: collectOwnProperties(target, reflectionErrors),
        timeValue: typeof timeValue === "number" && !Number.isNaN(timeValue) ? timeValue : { special: "invalid_date" }
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isInstance(target, RegExp)) {
      const sourceDescriptor = Reflect.getOwnPropertyDescriptor(RegExp.prototype, "source");
      const flagsDescriptor = Reflect.getOwnPropertyDescriptor(RegExp.prototype, "flags");
      const source = sourceDescriptor && typeof sourceDescriptor.get === "function"
        ? readIntrinsic(() => sourceDescriptor.get!.call(target), reflectionErrors)
        : undefined;
      const flags = flagsDescriptor && typeof flagsDescriptor.get === "function"
        ? readIntrinsic(() => flagsDescriptor.get!.call(target), reflectionErrors)
        : undefined;
      const lastIndex = readOwnDataDescriptor(target, "lastIndex");
      const node: EncodedNode = {
        kind: "regexp",
        tag: "[object RegExp]",
        properties: collectOwnProperties(target, reflectionErrors),
        ...(typeof source === "string" ? { source } : {}),
        ...(typeof flags === "string" ? { flags } : {}),
        ...(lastIndex ? { lastIndex: encodeValue(lastIndex.value) } : {})
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isInstance(target, Map)) {
      const entries = readIntrinsic(() => Array.from(Map.prototype.entries.call(target)), reflectionErrors);
      const node: EncodedNode = {
        kind: "map",
        tag: "[object Map]",
        properties: collectOwnProperties(target, reflectionErrors),
        ...(entries ? { entries: entries.map(([key, entryValue]) => ({ key: encodeValue(key), value: encodeValue(entryValue) })) } : {})
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isInstance(target, Set)) {
      const values = readIntrinsic(() => Array.from(Set.prototype.values.call(target)), reflectionErrors);
      const node: EncodedNode = {
        kind: "set",
        tag: "[object Set]",
        properties: collectOwnProperties(target, reflectionErrors),
        ...(values ? { values: values.map((item) => encodeValue(item)) } : {})
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isInstance(target, WeakMap)) {
      const node: EncodedNode = { kind: "weak_map", tag: "[object WeakMap]", properties: collectOwnProperties(target, reflectionErrors), contentsObservable: false };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isInstance(target, WeakSet)) {
      const node: EncodedNode = { kind: "weak_set", tag: "[object WeakSet]", properties: collectOwnProperties(target, reflectionErrors), contentsObservable: false };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isInstance(target, Promise)) {
      const node: EncodedNode = { kind: "promise", tag: "[object Promise]", properties: collectOwnProperties(target, reflectionErrors), stateObservable: false };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isInstance(target, ArrayBuffer) || (typeof SharedArrayBuffer !== "undefined" && isInstance(target, SharedArrayBuffer))) {
      const isShared = typeof SharedArrayBuffer !== "undefined" && isInstance(target, SharedArrayBuffer);
      const bytes = readIntrinsic(() => Buffer.from(new Uint8Array(target as ArrayBufferLike)).toString("base64"), reflectionErrors);
      const byteLength = readIntrinsic(() => (target as ArrayBuffer).byteLength, reflectionErrors);
      const node: EncodedNode = {
        kind: isShared ? "shared_array_buffer" : "array_buffer",
        tag: isShared ? "[object SharedArrayBuffer]" : "[object ArrayBuffer]",
        properties: collectOwnProperties(target, reflectionErrors),
        ...(typeof byteLength === "number" ? { byteLength } : {}),
        ...(typeof bytes === "string" ? { bytes } : {})
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (isBuffer(target, reflectionErrors)) {
      const buffer = target as Buffer;
      const node: EncodedNode = {
        kind: "buffer",
        tag: "[object Uint8Array]",
        properties: collectOwnProperties(target, reflectionErrors, { excludeArrayIndexes: true }),
        constructorName: "Buffer",
        byteOffset: buffer.byteOffset,
        byteLength: buffer.byteLength,
        length: buffer.length,
        bytes: Buffer.from(buffer).toString("base64")
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (ArrayBuffer.isView(target)) {
      const isDataView = isInstance(target, DataView);
      const typed = target as ArrayBufferView;
      const bytes = readIntrinsic(() => Buffer.from(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)).toString("base64"), reflectionErrors);
      const constructorName = getConstructorName(target, reflectionErrors);
      const length = !isDataView
        ? readIntrinsic(() => (target as unknown as { length: number }).length, reflectionErrors)
        : undefined;
      const node: EncodedNode = {
        kind: isDataView ? "data_view" : "typed_array",
        tag: isDataView ? "[object DataView]" : "[object TypedArray]",
        properties: collectOwnProperties(target, reflectionErrors, { excludeArrayIndexes: true }),
        ...(constructorName ? { constructorName } : {}),
        byteOffset: typed.byteOffset,
        byteLength: typed.byteLength,
        ...(typeof length === "number" ? { length } : {}),
        ...(typeof bytes === "string" ? { bytes } : {})
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (typeof URL !== "undefined" && isInstance(target, URL)) {
      const value = readIntrinsic(() => URL.prototype.toString.call(target), reflectionErrors);
      const node: EncodedNode = {
        kind: "url",
        tag: "[object URL]",
        properties: collectOwnProperties(target, reflectionErrors),
        ...(typeof value === "string" ? { value } : {})
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    if (typeof URLSearchParams !== "undefined" && isInstance(target, URLSearchParams)) {
      const value = readIntrinsic(() => URLSearchParams.prototype.toString.call(target), reflectionErrors);
      const node: EncodedNode = {
        kind: "url_search_params",
        tag: "[object URLSearchParams]",
        properties: collectOwnProperties(target, reflectionErrors),
        ...(typeof value === "string" ? { value } : {})
      };
      if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
      return node;
    }

    const state = readObjectState(target, reflectionErrors);
    const prototype = getPrototype(target, reflectionErrors);
    const constructorName = getConstructorName(target, reflectionErrors);
    const node: EncodedNode = {
      kind: prototype === Object.prototype || prototype === null ? "object" : "class_instance",
      tag: "[object Object]",
      properties: collectOwnProperties(target, reflectionErrors),
      ...(constructorName ? { constructorName } : {}),
      ...state
    };
    if (reflectionErrors.length) node.reflectionErrors = reflectionErrors;
    return node;
  };

  const root = encodeValue(value);
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]!;
    if (typeof item.value === "symbol") nodes[item.id] = encodeSymbolNode(item.value);
    else if (typeof item.value === "function") nodes[item.id] = encodeFunctionNode(item.value as (...args: never[]) => unknown);
    else nodes[item.id] = encodeObjectNode(item.value as object);
  }

  return { format: "awb-lossless-value-graph", version: 1, root, nodes };
}

export function captureLosslessSnapshot(value: unknown, capturedAt = Date.now()): LosslessSnapshot {
  return { capturedAt, graph: encodeLosslessValueGraph(value) };
}
