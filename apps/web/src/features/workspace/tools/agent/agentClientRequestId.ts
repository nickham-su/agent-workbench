type ClientCrypto = {
  randomUUID?: () => string;
  getRandomValues?: Crypto["getRandomValues"];
};

let fallbackSequence = 0;

function formatUuidV4(bytes: Uint8Array) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/** 生成发送消息使用的幂等请求 ID，并兼容缺少 randomUUID 的浏览器。 */
export function createAgentClientRequestId(
  cryptoSource: ClientCrypto | undefined =
    typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto,
) {
  if (typeof cryptoSource?.randomUUID === "function") return cryptoSource.randomUUID();
  if (typeof cryptoSource?.getRandomValues === "function") {
    return formatUuidV4(cryptoSource.getRandomValues(new Uint8Array(16)));
  }
  // 该 ID 仅用于请求去重，不承担密钥或凭证用途。
  fallbackSequence = (fallbackSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `request_${Date.now().toString(36)}_${fallbackSequence.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
