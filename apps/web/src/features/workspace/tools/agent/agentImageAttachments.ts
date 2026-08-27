export const AGENT_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const AGENT_IMAGE_MAX_COUNT = 4;
export const AGENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const AGENT_IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
export const AGENT_IMAGE_WEBP_QUALITY = 0.92;
export const AGENT_IMAGE_COMPRESSION_MIN_SAVINGS_RATIO = 0.1;

export type PendingAgentImage = {
  id: string;
  file: File;
  filename: string;
};

export type PendingAgentSendAttempt = {
  fingerprint: string;
  clientRequestId: string;
};

export function createAgentSendAttemptFingerprint(input: { draft: string; images: readonly PendingAgentImage[] }) {
  return JSON.stringify({
    draft: input.draft,
    images: input.images.map((image) => image.id)
  });
}

export function resolveAgentSendAttempt(input: {
  attempt: PendingAgentSendAttempt | null;
  fingerprint: string;
  makeClientRequestId: () => string;
}): PendingAgentSendAttempt {
  return input.attempt?.fingerprint === input.fingerprint
    ? input.attempt
    : { fingerprint: input.fingerprint, clientRequestId: input.makeClientRequestId() };
}

export type ImagePasteResult = {
  preventDefault: boolean;
  accepted: PendingAgentImage[];
  rejected: "count" | "type" | "empty" | "size" | "total" | null;
};

export type AgentImageWebpEncoder = (file: File) => Promise<Blob | null>;

function toWebpFilename(filename: string) {
  const stem = filename.trim().replace(/\.[^.]+$/, "") || "pasted-image";
  return `${stem}.webp`;
}

/** Encodes at the original dimensions so screenshot text remains legible. */
export async function compressAgentImageToWebp(file: File): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({ type: "image/webp", quality: AGENT_IMAGE_WEBP_QUALITY });
    }
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", AGENT_IMAGE_WEBP_QUALITY));
  } finally {
    bitmap.close();
  }
}

/** Returns the original when compression is unavailable, fails, or has no material size benefit. */
export async function maybeCompressAgentImage(
  file: File,
  encodeToWebp: AgentImageWebpEncoder = compressAgentImageToWebp
): Promise<File> {
  if (
    file.size <= AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES ||
    !AGENT_IMAGE_MEDIA_TYPES.has(file.type)
  ) return file;
  try {
    const compressed = await encodeToWebp(file);
    if (
      !compressed ||
      compressed.type !== "image/webp" ||
      compressed.size >= file.size * (1 - AGENT_IMAGE_COMPRESSION_MIN_SAVINGS_RATIO)
    ) return file;
    return new File([compressed], toWebpFilename(file.name), {
      type: "image/webp",
      lastModified: file.lastModified
    });
  } catch {
    return file;
  }
}

export async function preparePastedAgentImages(
  files: Iterable<File>,
  encodeToWebp?: AgentImageWebpEncoder
) {
  return await Promise.all([...files].map((file) => maybeCompressAgentImage(file, encodeToWebp)));
}

type ClipboardImageItem = {
  kind: string;
  type: string;
  getAsFile(): File | null;
};

export function collectClipboardAgentImageFiles(input: {
  items?: Iterable<ClipboardImageItem> | ArrayLike<ClipboardImageItem> | null;
  files?: Iterable<File> | null;
}) {
  const fromItems = Array.from(input.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  return fromItems.length > 0 ? fromItems : [...(input.files ?? [])];
}

export function formatAgentImageSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatPendingAgentImageLabel(image: PendingAgentImage) {
  return formatAgentImageSize(image.file.size);
}

function fallbackFilename(type: string) {
  if (type === "image/jpeg") return "pasted-image.jpg";
  if (type === "image/webp") return "pasted-image.webp";
  return "pasted-image.png";
}

export function collectPastedAgentImages(input: {
  files: Iterable<File>;
  existing: readonly PendingAgentImage[];
  hasText?: boolean;
  makeId: () => string;
}): ImagePasteResult {
  const pastedFiles = [...input.files];
  const files = pastedFiles.filter((file) => file.type.startsWith("image/"));
  if (files.length === 0) return { preventDefault: false, accepted: [], rejected: null };

  const accepted: PendingAgentImage[] = [];
  let total = input.existing.reduce((sum, image) => sum + image.file.size, 0);
  for (const file of files) {
    if (input.existing.length + accepted.length >= AGENT_IMAGE_MAX_COUNT) return { preventDefault: !input.hasText, accepted, rejected: "count" };
    if (!AGENT_IMAGE_MEDIA_TYPES.has(file.type)) return { preventDefault: !input.hasText, accepted, rejected: "type" };
    if (file.size < 1) return { preventDefault: !input.hasText, accepted, rejected: "empty" };
    if (file.size > AGENT_IMAGE_MAX_BYTES) return { preventDefault: !input.hasText, accepted, rejected: "size" };
    if (total + file.size > AGENT_IMAGE_MAX_TOTAL_BYTES) return { preventDefault: !input.hasText, accepted, rejected: "total" };
    total += file.size;
    accepted.push({ id: input.makeId(), file, filename: file.name.trim() || fallbackFilename(file.type) });
  }
  return { preventDefault: !input.hasText, accepted, rejected: null };
}

export function shouldBlockImageSlashCommand(command: "compact" | "clear" | "prompt" | null, imageCount: number) {
  return imageCount > 0 && (command === "compact" || command === "clear");
}

export function createAgentMessageFormData(payload: Record<string, unknown>, images: readonly PendingAgentImage[]) {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const image of images) form.append("images", image.file, image.filename);
  return form;
}

export class AttachmentPreviewCache {
  private readonly urls = new Map<string, string>();

  async get(
    attachmentId: string,
    load: (id: string) => Promise<Blob>,
    accept: () => boolean = () => true
  ): Promise<string | null> {
    const existing = this.urls.get(attachmentId);
    if (existing) return existing;
    const url = URL.createObjectURL(await load(attachmentId));
    if (!accept()) {
      URL.revokeObjectURL(url);
      return null;
    }
    const concurrent = this.urls.get(attachmentId);
    if (concurrent) {
      URL.revokeObjectURL(url);
      return concurrent;
    }
    this.urls.set(attachmentId, url);
    return url;
  }

  clear() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
