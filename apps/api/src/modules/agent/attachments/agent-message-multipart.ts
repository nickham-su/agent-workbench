import type { FastifyRequest } from "fastify";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AgentSendMessageMultipartPayloadSchema } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import { HttpError } from "../../../app/errors.js";
import { newSortableId } from "../../../utils/ids.js";
import { AGENT_IMAGE_MAX_COUNT, AGENT_IMAGE_MAX_TOTAL_BYTES } from "./agent-attachment-limits.js";
import { removeAgentAttachmentTempFile, stageAgentImageUpload } from "./agent-attachment-storage.js";

const AGENT_MULTIPART_MAX_PARTS = 1 + AGENT_IMAGE_MAX_COUNT;
const AGENT_MULTIPART_MAX_PAYLOAD_BYTES = 64 * 1024;

export type NormalizedSendMessageBody = {
  workspaceId: string;
  clientRequestId: string;
  text: string;
  agentId?: string;
  uiLocale?: "zh-CN" | "en-US";
  images: Array<{
    attachmentId: string;
    storageKey: string;
    tempId: string;
    filename: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
    byteSize: number;
    position: number;
    byteSha256: string;
  }>;
};

async function drainMultipartFile(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // Consume rejected parts so Busboy can finish the request safely.
  }
}

export async function parseAgentMessageMultipart(
  req: FastifyRequest,
  dataDir: string,
  payloadSchema: TSchema = AgentSendMessageMultipartPayloadSchema,
  maxPayloadBytes = AGENT_MULTIPART_MAX_PAYLOAD_BYTES,
): Promise<NormalizedSendMessageBody> {
  const images: NormalizedSendMessageBody["images"] = [];
  let payloadRaw: string | null = null;
  let totalBytes = 0;
  let partCount = 0;
  let invalid: Error | null = null;
  try {
    for await (const part of req.parts()) {
      partCount += 1;
      if (partCount > AGENT_MULTIPART_MAX_PARTS) {
        if (part.type === "file") await drainMultipartFile(part.file);
        invalid ??= new Error("too many multipart parts");
        continue;
      }
      if (invalid) {
        if (part.type === "file") await drainMultipartFile(part.file);
        continue;
      }
      if (part.type === "field") {
        if (
          part.fieldname !== "payload" ||
          payloadRaw !== null ||
          part.valueTruncated
        ) {
          invalid = new Error("invalid multipart payload field");
          continue;
        }
        const value =
          typeof part.value === "string" ? part.value : String(part.value);
        if (
          Buffer.byteLength(value, "utf8") > maxPayloadBytes
        ) {
          invalid = new Error("multipart payload is too large");
          continue;
        }
        payloadRaw = value;
        continue;
      }
      if (
        part.fieldname !== "images" ||
        images.length >= AGENT_IMAGE_MAX_COUNT
      ) {
        await drainMultipartFile(part.file);
        invalid = new Error("invalid multipart image field");
        continue;
      }
      const tempId = newSortableId("tmp");
      try {
        const image = await stageAgentImageUpload({
          dataDir,
          tempId,
          attachmentId: newSortableId("att"),
          filename: part.filename,
          stream: part.file,
          onBytes: (byteLength) => {
            totalBytes += byteLength;
          },
        });
        images.push({ ...image, position: images.length });
        // 当前文件必须被完整消费，否则 Busboy 会中止整个 multipart 请求并丢失稳定错误语义。
        if (totalBytes > AGENT_IMAGE_MAX_TOTAL_BYTES) {
          invalid = new HttpError(400, "agent images exceed total byte size limit", "AGENT_IMAGE_TOTAL_BYTES_EXCEEDED");
        }
      } catch (error) {
        await drainMultipartFile(part.file);
        // Filesystem failures may carry private absolute paths. Preserve only
        // static validation diagnostics from the staging authority.
        invalid = error instanceof HttpError ? error
          : error instanceof Error && ["Unsupported agent image file signature", "Invalid agent image byte size"].includes(error.message)
            ? new HttpError(400, error.message)
            : new HttpError(503, "Image upload could not be staged safely");
      }
    }
    if (invalid) throw invalid;
    if (payloadRaw === null) throw new Error("multipart payload is required");
    if (images.length === 0) throw new Error("multipart image is required");
    let payload: unknown;
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      throw new Error("multipart payload is not valid JSON");
    }
    if (!Value.Check(payloadSchema, payload)) {
      throw new Error("multipart payload is invalid");
    }
    const parsed = payload as { workspaceId: string; clientRequestId: string; text?: string; agentId?: string; uiLocale?: "zh-CN" | "en-US" };
    return {
      workspaceId: parsed.workspaceId,
      clientRequestId: parsed.clientRequestId,
      text: parsed.text ?? "",
      ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
      ...(parsed.uiLocale ? { uiLocale: parsed.uiLocale } : {}),
      images,
    };
  } catch (error) {
    await Promise.all(
      images.map((image) =>
        removeAgentAttachmentTempFile({ dataDir, tempId: image.tempId }).catch(
          () => undefined,
        ),
      ),
    );
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "invalid multipart request",
    );
  }
}

export async function removeStagedAgentMessageTemps(
  dataDir: string,
  body: NormalizedSendMessageBody,
) {
  await Promise.all(
    body.images.map((image) =>
      removeAgentAttachmentTempFile({ dataDir, tempId: image.tempId }).catch(
        () => undefined,
      ),
    ),
  );
}
