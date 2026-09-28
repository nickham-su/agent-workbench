import { createHash } from "node:crypto";
import type { ExecutionProfile } from "../../apiClient.js";

/** Opaque endpoint identity; never store the configured URL or credentials in replay. */
export function chatEndpointDigest(profile: ExecutionProfile): string {
  const baseURL = profile.provider.options.baseURL;
  // An implicit SDK default is deliberately not equated with an explicit default URL.
  const identity = typeof baseURL === "string" && baseURL.length > 0
    ? `configured\0${baseURL}` : "sdk-default";
  return createHash("sha256").update(identity).digest("hex");
}
