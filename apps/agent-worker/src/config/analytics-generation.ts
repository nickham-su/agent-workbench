/** Only UUIDs allocated by the parent are accepted; never interpolate raw input in errors. */
export function parseAnalyticsProducerGeneration(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid AWB_AGENT_ANALYTICS_GENERATION: expected a UUID v4");
  }
  return value;
}
