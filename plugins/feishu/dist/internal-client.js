export function createInternalClient(params) {
    const { apiOrigin, internalToken } = params;
    async function parseJsonSafe(res) {
        const text = await res.text();
        try {
            return text ? JSON.parse(text) : {};
        }
        catch {
            return { message: text };
        }
    }
    async function request(method, path, body, pluginId) {
        const headers = {
            "x-awb-agent-internal-token": internalToken
        };
        if (pluginId)
            headers["x-awb-plugin-id"] = pluginId;
        if (method === "POST")
            headers["content-type"] = "application/json";
        const res = await fetch(`${apiOrigin}${path}`, {
            method,
            headers,
            ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {})
        });
        const json = await parseJsonSafe(res);
        if (!res.ok) {
            const err = new Error(String(json?.message || `http ${res.status}`));
            err.statusCode = res.status;
            if (typeof json?.code === "string")
                err.code = json.code;
            throw err;
        }
        return json;
    }
    return {
        get(path, options) {
            return request("GET", path, undefined, options?.pluginId);
        },
        post(path, body, options) {
            const pluginId = options?.pluginId ?? (typeof body?.pluginId === "string" ? body.pluginId : undefined);
            return request("POST", path, body, pluginId);
        }
    };
}
