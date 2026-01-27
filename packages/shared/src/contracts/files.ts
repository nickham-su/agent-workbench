import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { GitTargetSchema } from "./git.js";

export const FileEntryKindSchema = Type.Union([Type.Literal("file"), Type.Literal("dir")]);
export type FileEntryKind = Static<typeof FileEntryKindSchema>;

export const FileEntrySchema = Type.Object(
  {
    name: Type.String(),
    path: Type.String(),
    kind: FileEntryKindSchema,
    size: Type.Optional(Type.Number()),
    mtimeMs: Type.Optional(Type.Number())
  }
);
export type FileEntry = Static<typeof FileEntrySchema>;

export const FileListRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    dir: Type.String()
  }
);
export type FileListRequest = Static<typeof FileListRequestSchema>;

export const FileListResponseSchema = Type.Object(
  {
    dir: Type.String(),
    entries: Type.Array(FileEntrySchema)
  }
);
export type FileListResponse = Static<typeof FileListResponseSchema>;

export const FileVersionSchema = Type.Object(
  {
    mtimeMs: Type.Number(),
    size: Type.Number(),
    hash: Type.Optional(Type.String())
  }
);
export type FileVersion = Static<typeof FileVersionSchema>;

export const FileReadRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    path: Type.String({ minLength: 1 })
  }
);
export type FileReadRequest = Static<typeof FileReadRequestSchema>;

const FileReadReasonSchema = Type.Union([
  Type.Literal("too_large"),
  Type.Literal("binary"),
  Type.Literal("decode_failed"),
  Type.Literal("unsafe_path"),
  Type.Literal("missing")
]);

export const FileReadResponseSchema = Type.Object(
  {
    path: Type.String(),
    previewable: Type.Boolean(),
    reason: Type.Optional(FileReadReasonSchema),
    bytes: Type.Optional(Type.Number()),
    content: Type.Optional(Type.String()),
    language: Type.Optional(Type.String()),
    version: Type.Optional(FileVersionSchema)
  }
);
export type FileReadResponse = Static<typeof FileReadResponseSchema>;

export const FileStatReasonSchema = Type.Union([
  Type.Literal("missing"),
  Type.Literal("unsafe_path"),
  Type.Literal("not_file"),
  Type.Literal("permission_denied")
]);
export type FileStatReason = Static<typeof FileStatReasonSchema>;

export const FileStatRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    path: Type.String({ minLength: 1 })
  }
);
export type FileStatRequest = Static<typeof FileStatRequestSchema>;

export const FileStatResponseSchema = Type.Object(
  {
    path: Type.String(),
    ok: Type.Boolean(),
    kind: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("dir")])),
    reason: Type.Optional(FileStatReasonSchema),
    version: Type.Optional(FileVersionSchema),
    normalizedPath: Type.Optional(Type.String())
  }
);
export type FileStatResponse = Static<typeof FileStatResponseSchema>;

export const FileWriteRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    path: Type.String({ minLength: 1 }),
    content: Type.String(),
    expected: Type.Optional(FileVersionSchema),
    force: Type.Optional(Type.Boolean())
  }
);
export type FileWriteRequest = Static<typeof FileWriteRequestSchema>;

export const FileWriteResponseSchema = Type.Object(
  {
    path: Type.String(),
    version: FileVersionSchema
  }
);
export type FileWriteResponse = Static<typeof FileWriteResponseSchema>;

export const FileCreateRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    path: Type.String({ minLength: 1 }),
    content: Type.Optional(Type.String())
  }
);
export type FileCreateRequest = Static<typeof FileCreateRequestSchema>;

export const FileCreateResponseSchema = FileWriteResponseSchema;
export type FileCreateResponse = Static<typeof FileCreateResponseSchema>;

export const FileMkdirRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    path: Type.String({ minLength: 1 })
  }
);
export type FileMkdirRequest = Static<typeof FileMkdirRequestSchema>;

export const FileMkdirResponseSchema = Type.Object(
  {
    path: Type.String()
  }
);
export type FileMkdirResponse = Static<typeof FileMkdirResponseSchema>;

export const FileRenameRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 })
  }
);
export type FileRenameRequest = Static<typeof FileRenameRequestSchema>;

export const FileRenameResponseSchema = Type.Object(
  {
    from: Type.String(),
    to: Type.String()
  }
);
export type FileRenameResponse = Static<typeof FileRenameResponseSchema>;

export const FileDeleteRequestSchema = Type.Object(
  {
    target: GitTargetSchema,
    path: Type.String({ minLength: 1 }),
    recursive: Type.Optional(Type.Boolean())
  }
);
export type FileDeleteRequest = Static<typeof FileDeleteRequestSchema>;

export const FileDeleteResponseSchema = Type.Object(
  {
    path: Type.String()
  }
);
export type FileDeleteResponse = Static<typeof FileDeleteResponseSchema>;

const FileSearchHighlightRangeSchema = Type.Object({
  kind: Type.Literal("range"),
  startCol: Type.Number(),
  endCol: Type.Number()
});

const FileSearchHighlightLineSchema = Type.Object({
  kind: Type.Literal("line")
});

export const FileSearchHighlightSchema = Type.Union([FileSearchHighlightRangeSchema, FileSearchHighlightLineSchema]);
export type FileSearchHighlight = Static<typeof FileSearchHighlightSchema>;

export const FileSearchMatchSchema = Type.Object({
  path: Type.String(),
  line: Type.Number(),
  lineText: Type.String(),
  highlight: FileSearchHighlightSchema
});
export type FileSearchMatch = Static<typeof FileSearchMatchSchema>;

export const FileSearchBlockLineSchema = Type.Object({
  line: Type.Number(),
  text: Type.String(),
  hits: Type.Optional(Type.Array(FileSearchHighlightRangeSchema))
});
export type FileSearchBlockLine = Static<typeof FileSearchBlockLineSchema>;

export const FileSearchBlockSchema = Type.Object({
  path: Type.String(),
  fromLine: Type.Number(),
  toLine: Type.Number(),
  lines: Type.Array(FileSearchBlockLineSchema),
  hitLines: Type.Array(Type.Number())
});
export type FileSearchBlock = Static<typeof FileSearchBlockSchema>;

export const FileSearchRequestSchema = Type.Object({
  target: GitTargetSchema,
  query: Type.String({ minLength: 1 }),
  useRegex: Type.Boolean(),
  caseSensitive: Type.Boolean(),
  wholeWord: Type.Optional(Type.Boolean())
});
export type FileSearchRequest = Static<typeof FileSearchRequestSchema>;

export const FileSearchResponseSchema = Type.Object({
  query: Type.String(),
  useRegex: Type.Boolean(),
  caseSensitive: Type.Boolean(),
  wholeWord: Type.Optional(Type.Boolean()),
  limit: Type.Number(),
  matches: Type.Array(FileSearchMatchSchema),
  blocks: Type.Array(FileSearchBlockSchema),
  truncated: Type.Boolean(),
  timedOut: Type.Boolean(),
  tookMs: Type.Number(),
  ignoredByVcs: Type.Boolean(),
  ignoredByDotIgnore: Type.Boolean()
});
export type FileSearchResponse = Static<typeof FileSearchResponseSchema>;
