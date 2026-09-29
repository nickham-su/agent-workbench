import { Type, type Static } from "@sinclair/typebox";

// C0/C1 controls plus invisible format and bidirectional controls must never enter a path
// displayed to a user/model. The file reader still validates filesystem containment.
const DISALLOWED_PATH_CHARACTERS = String.raw`\\:\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB`;

/** Wire-level path validation; file containment and symlink checks remain the reader's responsibility. */
export const AgentWorkspaceImagePathSchema = Type.String({
  minLength: 1,
  pattern: `^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[^${DISALLOWED_PATH_CHARACTERS}]+$`
});
export type AgentWorkspaceImagePath = Static<typeof AgentWorkspaceImagePathSchema>;

export const AgentImageRefSchema = Type.Object({
  type: Type.Literal("image_ref"),
  path: AgentWorkspaceImagePathSchema
}, { additionalProperties: false });
export type AgentImageRef = Static<typeof AgentImageRefSchema>;

/** The only structured result accepted from a completed view_image execution. */
export const AgentViewImageResultSchema = AgentImageRefSchema;
export type AgentViewImageResult = AgentImageRef;

/** UI/history preview only, never evidence that image bytes reached a model. */
export function viewImagePathPreview(path: string): string {
  return `view_image path: ${path} (image not attached to this preview)`;
}

const AgentToolTextSchema = Type.Object({
  type: Type.Literal("text"), value: Type.String()
}, { additionalProperties: false });
const AgentToolErrorTextSchema = Type.Object({
  type: Type.Literal("error-text"), value: Type.String()
}, { additionalProperties: false });

/** Errors are standalone. Successful arrays are flat, nonempty and contain no errors. */
export const AgentToolResultOutputSchema = Type.Union([
  AgentToolTextSchema,
  AgentToolErrorTextSchema,
  AgentImageRefSchema,
  Type.Array(Type.Union([AgentToolTextSchema, AgentImageRefSchema]), { minItems: 1 })
]);
export type AgentToolResultOutput = Static<typeof AgentToolResultOutputSchema>;
