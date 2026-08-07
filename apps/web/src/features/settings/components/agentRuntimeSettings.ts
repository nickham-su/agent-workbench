export type RuntimeModelReference = {
  providerId: string;
  modelId: string;
};

export function modelPathFromReference(reference: RuntimeModelReference | null | undefined): string[] {
  return reference ? [reference.providerId, reference.modelId] : [];
}

export function modelReferenceFromPath(
  path: string[],
  hasModel: (providerId: string, modelId: string) => boolean
): RuntimeModelReference | null | undefined {
  if (!Array.isArray(path) || path.length === 0) return null;
  const [providerId, modelId] = path;
  if (!providerId || !modelId) return undefined;
  if (!hasModel(providerId, modelId)) return undefined;
  return { providerId, modelId };
}
