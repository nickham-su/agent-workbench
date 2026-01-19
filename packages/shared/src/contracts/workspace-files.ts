import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { FileVersionSchema } from "./files.js";

export const WorkspaceFileListRequestSchema = Type.Object({
  dir: Type.String()
});
export type WorkspaceFileListRequest = Static<typeof WorkspaceFileListRequestSchema>;

export const WorkspaceFileStatRequestSchema = Type.Object({
  path: Type.String({ minLength: 1 })
});
export type WorkspaceFileStatRequest = Static<typeof WorkspaceFileStatRequestSchema>;

export const WorkspaceFileReadRequestSchema = Type.Object({
  path: Type.String({ minLength: 1 })
});
export type WorkspaceFileReadRequest = Static<typeof WorkspaceFileReadRequestSchema>;

export const WorkspaceFileWriteRequestSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
  expected: Type.Optional(FileVersionSchema),
  force: Type.Optional(Type.Boolean())
});
export type WorkspaceFileWriteRequest = Static<typeof WorkspaceFileWriteRequestSchema>;

export const WorkspaceFileCreateRequestSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.Optional(Type.String())
});
export type WorkspaceFileCreateRequest = Static<typeof WorkspaceFileCreateRequestSchema>;

export const WorkspaceFileMkdirRequestSchema = Type.Object({
  path: Type.String({ minLength: 1 })
});
export type WorkspaceFileMkdirRequest = Static<typeof WorkspaceFileMkdirRequestSchema>;

export const WorkspaceFileRenameRequestSchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 })
});
export type WorkspaceFileRenameRequest = Static<typeof WorkspaceFileRenameRequestSchema>;

export const WorkspaceFileDeleteRequestSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  recursive: Type.Optional(Type.Boolean())
});
export type WorkspaceFileDeleteRequest = Static<typeof WorkspaceFileDeleteRequestSchema>;

export const WorkspaceFileSearchScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("repos")]);
export type WorkspaceFileSearchScope = Static<typeof WorkspaceFileSearchScopeSchema>;

export const WorkspaceFileSearchRequestSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  useRegex: Type.Boolean(),
  caseSensitive: Type.Boolean(),
  wholeWord: Type.Optional(Type.Boolean()),
  scope: WorkspaceFileSearchScopeSchema,
  repoDirNames: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});
export type WorkspaceFileSearchRequest = Static<typeof WorkspaceFileSearchRequestSchema>;
