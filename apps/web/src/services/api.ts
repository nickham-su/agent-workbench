import axios from "axios";
import type {
  CreateRepoRequest,
  CreateCredentialRequest,
  CreateTerminalRequest,
  CreateWorkspaceRequest,
  ChangesResponse,
  CredentialRecord,
  FileCompareResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitDiscardRequest,
  GitPullRequest,
  GitPullResponse,
  GitPushRequest,
  GitPushResponse,
  GitStageRequest,
  GitUnstageRequest,
  NetworkSettings,
  RepoBranchesResponse,
  RepoRecord,
  RepoSyncResponse,
  ResetKnownHostRequest,
  SecurityStatus,
  SwitchWorkspaceBranchRequest,
  TerminalRecord,
  UpdateCredentialRequest,
  UpdateNetworkSettingsRequest,
  UpdateRepoRequest,
  WorkspaceDetail,
} from "@agent-workbench/shared";

const client = axios.create({ baseURL: "/api" });

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

export async function listRepos() {
  try {
    const res = await client.get<RepoRecord[]>("/repos");
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

export async function getNetworkSettings() {
  try {
    const res = await client.get<NetworkSettings>("/settings/network");
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

export async function deleteWorkspace(workspaceId: string) {
  try {
    await client.delete(`/workspaces/${workspaceId}`);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function checkoutWorkspace(workspaceId: string, body: SwitchWorkspaceBranchRequest) {
  try {
    const res = await client.post<{ branch: string }>(`/workspaces/${workspaceId}/git/checkout`, body);
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

export async function listChanges(workspaceId: string, params: { mode: "unstaged" | "staged" }) {
  try {
    const res = await client.get<ChangesResponse>(`/workspaces/${workspaceId}/changes`, {
      params: { mode: params.mode }
    });
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function fileCompare(
  workspaceId: string,
  params: { mode: "unstaged" | "staged"; path: string; oldPath?: string }
) {
  try {
    const res = await client.get<FileCompareResponse>(`/workspaces/${workspaceId}/file-compare`, {
      params: {
        mode: params.mode,
        path: params.path,
        oldPath: params.oldPath
      }
    });
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function stageWorkspace(workspaceId: string, body: GitStageRequest) {
  try {
    await client.post(`/workspaces/${workspaceId}/git/stage`, body);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function unstageWorkspace(workspaceId: string, body: GitUnstageRequest) {
  try {
    await client.post(`/workspaces/${workspaceId}/git/unstage`, body);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function discardWorkspace(workspaceId: string, body: GitDiscardRequest) {
  try {
    await client.post(`/workspaces/${workspaceId}/git/discard`, body);
  } catch (err) {
    throw toApiError(err);
  }
}

export async function commitWorkspace(workspaceId: string, body: GitCommitRequest) {
  try {
    const res = await client.post<GitCommitResponse>(`/workspaces/${workspaceId}/git/commit`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function pushWorkspace(workspaceId: string, body: GitPushRequest = {}) {
  try {
    const res = await client.post<GitPushResponse>(`/workspaces/${workspaceId}/git/push`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export async function pullWorkspace(workspaceId: string, body: GitPullRequest = {}) {
  try {
    const res = await client.post<GitPullResponse>(`/workspaces/${workspaceId}/git/pull`, body);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}
