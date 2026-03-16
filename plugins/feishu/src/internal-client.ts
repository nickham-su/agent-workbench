type HttpErrorLike = Error & { statusCode?: number; code?: string };

export function createInternalClient(params: { apiOrigin: string; internalToken: string }) {
  const { apiOrigin, internalToken } = params;

  async function parseJsonSafe(res: Response) {
    const text = await res.text();
    try {
      return text ? (JSON.parse(text) as any) : {};
    } catch {
      return { message: text };
    }
  }

  async function request(method: "GET" | "POST", path: string, body?: unknown, pluginId?: string) {
    const headers: Record<string, string> = {
      "x-awb-agent-internal-token": internalToken
    };
    if (pluginId) headers["x-awb-plugin-id"] = pluginId;
    if (method === "POST") headers["content-type"] = "application/json";

    const res = await fetch(`${apiOrigin}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {})
    });
    const json = await parseJsonSafe(res);
    if (!res.ok) {
      const err = new Error(String(json?.message || `http ${res.status}`)) as HttpErrorLike;
      err.statusCode = res.status;
      if (typeof json?.code === "string") err.code = json.code;
      throw err;
    }
    return json;
  }

  return {
    get(path: string, options?: { pluginId?: string }) {
      return request("GET", path, undefined, options?.pluginId);
    },
    post(path: string, body?: any, options?: { pluginId?: string }) {
      const pluginId = options?.pluginId ?? (typeof body?.pluginId === "string" ? body.pluginId : undefined);
      return request("POST", path, body, pluginId);
    }
  };
}
