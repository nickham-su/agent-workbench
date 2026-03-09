import axios from "axios";
import type {
  AuthLoginRequest,
  AuthLoginResponse,
  ClearAllGitIdentityResponse,
  CreateRepoRequest,
  CreateCredentialRequest,
  FileCreateRequest,
  FileCreateResponse,
  FileDeleteRequest,
  FileDeleteResponse,
  FileListRequest,
  FileListResponse,
  FileMkdirRequest,
  FileMkdirResponse,
  FileReadRequest,
  FileReadResponse,
  FileStatRequest,
  FileStatResponse,
  FileRenameRequest,
  FileRenameResponse,
  FileWriteRequest,
  FileWriteResponse,
  WorkspaceFileCreateRequest,
  WorkspaceFileDeleteRequest,
  WorkspaceFileListRequest,
  WorkspaceFileMkdirRequest,
  WorkspaceFileReadRequest,
  WorkspaceFileRenameRequest,
  WorkspaceFileSearchRequest,
  WorkspaceFileStatRequest,
  WorkspaceFileUploadResponse,
  WorkspaceFileWriteRequest,
  CreateTerminalRequest,
  CreateWorkspaceRequest,
  AttachWorkspaceRepoRequest,
  ChangesResponse,
  CredentialRecord,
  GenerateSshKeypairResponse,
  FileCompareResponse,
  GitBranchesRequest,
  GitBranchesResponse,
  GitCheckoutRequest,
  GitCheckoutResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitDiscardRequest,
  GitGlobalIdentity,
  GitIdentitySetRequest,
  GitIdentityStatusRequest,
  GitIdentityStatus,
  GitPullRequest,
  GitPullResponse,
  GitPushRequest,
  GitPushResponse,
  GitStageRequest,
  GitStatusRequest,
  GitStatusResponse,
  GitTarget,
  GitUnstageRequest,
  NetworkSettings,
  RepoBranchesResponse,
  RepoRecord,
  RepoSyncResponse,
  ResetKnownHostRequest,
  SecurityStatus,
  HealthResponse,
  TerminalRecord,
  UpdateCredentialRequest,
  UpdateGitGlobalIdentityRequest,
  UpdateNetworkSettingsRequest,
  UpdateSearchSettingsRequest,
  UpdateRepoRequest,
  UpdateWorkspaceRequest,
  WorkspaceDetail,
  SearchSettings,
  FileSearchRequest,
  FileSearchResponse,
  AgentCreateSessionRequest,
  AgentForkSessionRequest,
  AgentRevertSessionRequest,
  AgentClearSessionRequest,
  AgentCompactSessionRequest,
  AgentCompactSessionResponse,
  AgentSendMessageRequest,
  AgentSendMessageResponse,
  AgentContextItemsResponse,
  AgentContextItemRecord,
  AgentSessionRecord,
  AgentSessionRunState,
  AgentControlResult,
  AgentCancelSessionRequest,
  AgentProvidersSettingsView,
  AgentGlobalPromptSettings,
  AgentMcpSettings,
  AgentRuntimeSettings,
  UpdateAgentMcpSettingsRequest,
  UpdateAgentProvidersSettingsRequest,
  UpdateAgentGlobalPromptSettingsRequest,
  UpdateAgentRuntimeSettingsRequest,
  AgentSettings,
  AgentSettingsView,
  UpdateAgentSettingsRequest
} from "@agent-workbench/shared";
import { emitUnauthorized } from "@/features/auth/unauthorized";
import { resetAuthStatus, setAuthed } from "@/features/auth/session";

const client = axios.create({ baseURL: "/api" });

let lastUnauthorizedAt = 0;
client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 401) {
        const now = Date.now();
        if (now - lastUnauthorizedAt > 500) {
          lastUnauthorizedAt = now;
          resetAuthStatus();
          emitUnauthorized();
        }
      }
    }
    return Promise.reject(err);
  }
);

export class ApiError extends Error {
  code?: string;
  status?: number;

  constructor(params: { message: string; code?: string; status?: number }) {
    super(params.message);
    this.name = "ApiError";
    this.code = params.code;
    this.status = params.status;
  }
}

function toApiError(err: unknown) {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as any;
    return new ApiError({
      message: data?.message || err.message,
      code: data?.code,
      status: err.response?.status
    });
  }
  return new ApiError({
    message: err instanceof Error ? err.message : String(err)
  });
}

function parseContentDispositionFilename(value: string | undefined) {
  if (!value) return null;
  const parts = value.split(";").map((part) => part.trim());
  const star = parts.find((part) => part.toLowerCase().startsWith("filename*="));
  if (star) {
    const raw = star.slice("filename*=".length).replace(/^\"|\"$/g, "");
    const encoded = raw.includes("''") ? raw.split("''")[1] ?? "" : raw;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded || null;
    }
  }
  const plain = parts.find((part) => part.toLowerCase().startsWith("filename="));
  if (plain) {
    return plain.slice("filename=".length).replace(/^\"|\"$/g, "") || null;
  }
  return null;
}

export async function listRepos() {
  try {
    const res = await client.get<RepoRecord[]>("/repos");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getHealth() {
  try {
    const res = await client.get<HealthResponse>("/health");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function login(body: AuthLoginRequest) {
  try {
    const res = await client.post<AuthLoginResponse>("/auth/login", body);
    setAuthed(true);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getRepo(repoId: string) {
  try {
    const res = await client.get<RepoRecord>(`/repos/${repoId}`);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function createRepo(body: CreateRepoRequest) {
  try {
    const res = await client.post<RepoRecord>("/repos", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateRepo(repoId: string, body: UpdateRepoRequest) {
  try {
    const res = await client.patch<RepoRecord>(`/repos/${repoId}`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function syncRepo(repoId: string) {
  try {
    const res = await client.post<RepoSyncResponse>(`/repos/${repoId}/sync`);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function deleteRepo(repoId: string) {
  try {
    await client.delete(`/repos/${repoId}`);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function repoBranches(repoId: string) {
  try {
    const res = await client.get<RepoBranchesResponse>(`/repos/${repoId}/branches`);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listCredentials() {
  try {
    const res = await client.get<CredentialRecord[]>("/credentials");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function createCredential(body: CreateCredentialRequest) {
  try {
    const res = await client.post<CredentialRecord>("/credentials", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateCredential(credentialId: string, body: UpdateCredentialRequest) {
  try {
    const res = await client.patch<CredentialRecord>(`/credentials/${credentialId}`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function deleteCredential(credentialId: string) {
  try {
    await client.delete(`/credentials/${credentialId}`);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function generateSshKeypair() {
  try {
    const res = await client.post<GenerateSshKeypairResponse>("/credentials/ssh/keypair/generate");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getNetworkSettings() {
  try {
    const res = await client.get<NetworkSettings>("/settings/network");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getSearchSettings() {
  try {
    const res = await client.get<SearchSettings>("/settings/search");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateNetworkSettings(body: UpdateNetworkSettingsRequest) {
  try {
    const res = await client.put<NetworkSettings>("/settings/network", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateSearchSettings(body: UpdateSearchSettingsRequest) {
  try {
    const res = await client.put<SearchSettings>("/settings/search", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getSecurityStatus() {
  try {
    const res = await client.get<SecurityStatus>("/settings/security");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function resetKnownHost(body: ResetKnownHostRequest) {
  try {
    await client.post("/settings/security/ssh/known-hosts/reset", body);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listWorkspaces() {
  try {
    const res = await client.get<WorkspaceDetail[]>("/workspaces");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getWorkspace(workspaceId: string) {
  try {
    const res = await client.get<WorkspaceDetail>(`/workspaces/${workspaceId}`);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function createWorkspace(body: CreateWorkspaceRequest) {
  try {
    const res = await client.post<WorkspaceDetail>("/workspaces", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateWorkspace(workspaceId: string, body: UpdateWorkspaceRequest) {
  try {
    const res = await client.patch<WorkspaceDetail>(`/workspaces/${workspaceId}`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function deleteWorkspace(workspaceId: string) {
  try {
    await client.delete(`/workspaces/${workspaceId}`);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function attachWorkspaceRepo(workspaceId: string, body: AttachWorkspaceRepoRequest) {
  try {
    const res = await client.post<WorkspaceDetail>(`/workspaces/${workspaceId}/repos`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function detachWorkspaceRepo(workspaceId: string, repoId: string) {
  try {
    const res = await client.delete<WorkspaceDetail>(`/workspaces/${workspaceId}/repos/${repoId}`);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listTerminals(workspaceId: string) {
  try {
    const res = await client.get<TerminalRecord[]>(`/workspaces/${workspaceId}/terminals`);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function createTerminal(workspaceId: string, body: CreateTerminalRequest) {
  try {
    const res = await client.post<TerminalRecord>(`/workspaces/${workspaceId}/terminals`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function deleteTerminal(terminalId: string) {
  try {
    await client.delete(`/terminals/${terminalId}`);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listChanges(target: GitTarget, params: { mode: "unstaged" | "staged" }) {
  try {
    const res = await client.post<ChangesResponse>("/git/changes", { target, mode: params.mode });
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function fileCompare(target: GitTarget, params: { mode: "unstaged" | "staged"; path: string; oldPath?: string }) {
  try {
    const res = await client.post<FileCompareResponse>("/git/file-compare", {
      target,
      mode: params.mode,
      path: params.path,
      oldPath: params.oldPath
    });
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function stageWorkspace(body: GitStageRequest) {
  try {
    await client.post("/git/stage", body);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function unstageWorkspace(body: GitUnstageRequest) {
  try {
    await client.post("/git/unstage", body);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function discardWorkspace(body: GitDiscardRequest) {
  try {
    await client.post("/git/discard", body);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function commitWorkspace(body: GitCommitRequest) {
  try {
    const res = await client.post<GitCommitResponse>("/git/commit", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function pushWorkspace(body: GitPushRequest) {
  try {
    const res = await client.post<GitPushResponse>("/git/push", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function pullWorkspace(body: GitPullRequest) {
  try {
    const res = await client.post<GitPullResponse>("/git/pull", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function gitCheckout(body: GitCheckoutRequest) {
  try {
    const res = await client.post<GitCheckoutResponse>("/git/checkout", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function gitBranches(body: GitBranchesRequest) {
  try {
    const res = await client.post<GitBranchesResponse>("/git/branches", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getGitStatus(body: GitStatusRequest) {
  try {
    const res = await client.post<GitStatusResponse>("/git/status", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getWorkspaceGitIdentity(body: GitIdentityStatusRequest) {
  try {
    const res = await client.post<GitIdentityStatus>("/git/identity/status", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function setWorkspaceGitIdentity(body: GitIdentitySetRequest) {
  try {
    await client.put("/git/identity", body);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listFiles(body: FileListRequest) {
  try {
    const res = await client.post<FileListResponse>("/files/list", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function searchFiles(body: FileSearchRequest) {
  try {
    const res = await client.post<FileSearchResponse>("/files/search", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function statFile(body: FileStatRequest) {
  try {
    const res = await client.post<FileStatResponse>("/files/stat", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function readFileText(body: FileReadRequest) {
  try {
    const res = await client.post<FileReadResponse>("/files/read-text", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function writeFileText(body: FileWriteRequest) {
  try {
    const res = await client.post<FileWriteResponse>("/files/write-text", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function createFile(body: FileCreateRequest) {
  try {
    const res = await client.post<FileCreateResponse>("/files/create", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function mkdirPath(body: FileMkdirRequest) {
  try {
    const res = await client.post<FileMkdirResponse>("/files/mkdir", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function renamePath(body: FileRenameRequest) {
  try {
    const res = await client.post<FileRenameResponse>("/files/rename", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function deletePath(body: FileDeleteRequest) {
  try {
    const res = await client.post<FileDeleteResponse>("/files/delete", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listWorkspaceFiles(params: { workspaceId: string } & WorkspaceFileListRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileListResponse>(`/workspaces/${workspaceId}/files/list`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function searchWorkspaceFiles(params: { workspaceId: string } & WorkspaceFileSearchRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileSearchResponse>(`/workspaces/${workspaceId}/files/search`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function statWorkspaceFile(params: { workspaceId: string } & WorkspaceFileStatRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileStatResponse>(`/workspaces/${workspaceId}/files/stat`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function readWorkspaceFileText(params: { workspaceId: string } & WorkspaceFileReadRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileReadResponse>(`/workspaces/${workspaceId}/files/read-text`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function writeWorkspaceFileText(params: { workspaceId: string } & WorkspaceFileWriteRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileWriteResponse>(`/workspaces/${workspaceId}/files/write-text`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function createWorkspaceFile(params: { workspaceId: string } & WorkspaceFileCreateRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileCreateResponse>(`/workspaces/${workspaceId}/files/create`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function mkdirWorkspacePath(params: { workspaceId: string } & WorkspaceFileMkdirRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileMkdirResponse>(`/workspaces/${workspaceId}/files/mkdir`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function renameWorkspacePath(params: { workspaceId: string } & WorkspaceFileRenameRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileRenameResponse>(`/workspaces/${workspaceId}/files/rename`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function deleteWorkspacePath(params: { workspaceId: string } & WorkspaceFileDeleteRequest) {
  try {
    const { workspaceId, ...body } = params;
    const res = await client.post<FileDeleteResponse>(`/workspaces/${workspaceId}/files/delete`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function uploadWorkspaceFiles(params: { workspaceId: string; dir: string; files: File[] }) {
  try {
    const { workspaceId, dir, files } = params;
    const form = new FormData();
    for (const file of files) {
      form.append("files", file, file.name);
    }
    const res = await client.post<WorkspaceFileUploadResponse>(`/workspaces/${workspaceId}/files/upload`, form, {
      params: { dir }
    });
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function downloadWorkspacePath(params: { workspaceId: string; path: string }) {
  const { workspaceId, path } = params;
  try {
    const res = await client.get<Blob>(`/workspaces/${workspaceId}/files/download`, {
      params: { path },
      responseType: "blob"
    });
    const header = res.headers?.["content-disposition"] as string | undefined;
    const filename = parseContentDispositionFilename(header);
    return { blob: res.data, filename };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const data = err.response?.data;
      if (data instanceof Blob) {
        let message = err.message;
        let code: string | undefined;
        try {
          const text = await data.text();
          const json = JSON.parse(text);
          if (typeof json?.message === "string") message = json.message;
          if (typeof json?.code === "string") code = json.code;
        } catch {
          // 忽略解析失败
        }
        throw new ApiError({ message, code, status: err.response?.status });
      }
    }
    throw toApiError(err);
  }
}

export async function getGitGlobalIdentity() {
  try {
    const res = await client.get<GitGlobalIdentity>("/settings/git/identity");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateGitGlobalIdentity(body: UpdateGitGlobalIdentityRequest) {
  try {
    const res = await client.put<GitGlobalIdentity>("/settings/git/identity", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function clearAllGitIdentity() {
  try {
    const res = await client.post<ClearAllGitIdentityResponse>("/settings/git/identity/clear-all");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getAgentProvidersSettings() {
  try {
    const res = await client.get<AgentProvidersSettingsView>("/settings/agent/providers");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateAgentProvidersSettings(body: UpdateAgentProvidersSettingsRequest) {
  try {
    const res = await client.put<AgentProvidersSettingsView>("/settings/agent/providers", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getAgentRuntimeSettings() {
  try {
    const res = await client.get<AgentRuntimeSettings>("/settings/agent/runtime");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateAgentRuntimeSettings(body: UpdateAgentRuntimeSettingsRequest) {
  try {
    const res = await client.put<AgentRuntimeSettings>("/settings/agent/runtime", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getAgentSettings() {
  try {
    const res = await client.get<AgentSettingsView>("/settings/agent/agents");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getAgentGlobalPromptSettings() {
  try {
    const res = await client.get<AgentGlobalPromptSettings>("/settings/agent/global-prompts");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateAgentGlobalPromptSettings(body: UpdateAgentGlobalPromptSettingsRequest) {
  try {
    const res = await client.put<AgentGlobalPromptSettings>("/settings/agent/global-prompts", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getAgentMcpSettings() {
  try {
    const res = await client.get<AgentMcpSettings>("/settings/agent/mcp");
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateAgentMcpSettings(body: UpdateAgentMcpSettingsRequest) {
  try {
    const res = await client.put<AgentMcpSettings>("/settings/agent/mcp", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function updateAgentSettings(body: UpdateAgentSettingsRequest) {
  try {
    const res = await client.put<AgentSettings>("/settings/agent/agents", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function listAgentSessions(workspaceId: string) {
  try {
    const res = await client.get<AgentSessionRecord[]>("/agent/sessions", {
      params: { workspaceId }
    });
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function createAgentSession(body: AgentCreateSessionRequest) {
  try {
    const res = await client.post<AgentSessionRecord>("/agent/sessions", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getAgentContextItems(
  sessionId: string,
  query?:
    | number
    | {
        afterId?: number;
        tailLimit?: number;
        beforeId?: number;
        limit?: number;
        expectedHeadItemId?: number;
      }
) {
  try {
    const params =
      typeof query === "number"
        ? { afterId: query }
        : query && typeof query === "object"
          ? query
          : undefined;
    const res = await client.get<AgentContextItemsResponse>(`/agent/sessions/${sessionId}/context-items`, {
      params
    });
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getAgentContextItem(sessionId: string, itemId: number) {
  try {
    const res = await client.get<AgentContextItemRecord>(`/agent/sessions/${sessionId}/context-items/${itemId}`);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function getAgentRunState(sessionId: string) {
  try {
    const res = await client.get<AgentSessionRunState>(`/agent/sessions/${sessionId}/run-state`);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function sendAgentMessage(sessionId: string, body: AgentSendMessageRequest) {
  try {
    const res = await client.post<AgentSendMessageResponse>(`/agent/sessions/${sessionId}/messages`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function compactAgentSession(sessionId: string, body: AgentCompactSessionRequest) {
  try {
    const res = await client.post<AgentCompactSessionResponse>(`/agent/sessions/${sessionId}/compact`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function clearAgentSession(sessionId: string, body: AgentClearSessionRequest) {
  try {
    const res = await client.post<AgentControlResult>(`/agent/sessions/${sessionId}/clear`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function cancelAgentSession(sessionId: string, body: AgentCancelSessionRequest) {
  try {
    const res = await client.post<AgentControlResult>(`/agent/sessions/${sessionId}/cancel`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function forkAgentSession(body: AgentForkSessionRequest) {
  try {
    const res = await client.post<AgentSessionRecord>("/agent/sessions/fork", body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function revertAgentSession(sessionId: string, body: AgentRevertSessionRequest) {
  try {
    const res = await client.post<AgentControlResult>(`/agent/sessions/${sessionId}/revert`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}
