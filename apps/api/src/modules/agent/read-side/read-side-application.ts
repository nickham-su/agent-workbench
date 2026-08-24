import type {
  AgentApiExecutionProfileRequest,
  AgentApiMessagesContextRequest,
  AgentApiPromptContextRequest
} from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../../app/errors.js";

export type ReadSideSession = {
  workspaceId: string;
  kind: "primary" | "subtask";
  headItemId: number | null;
};

export type ReadSideRun = {
  runId: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  subtaskDepth: number | null;
};

/**
 * P3-P5 application boundary for API read-side use cases. It centralizes
 * ownership validation before delegating to narrow read-only collaborators.
 * This class never receives AgentService, AppContext, or runtime.
 */
export type ReadSideApplicationDependencies<ExecutionProfileResponse, MessagesContextResponse, PromptContextResponse> = {
  findSession: (sessionId: string) => ReadSideSession | null;
  findRun: (runId: string) => ReadSideRun | null;
  ensureWorkspace: (workspaceId: string) => void;
  resolveExecutionProfile: (input: {
    workspaceId: string;
    sessionId: string;
    session: ReadSideSession;
    run: ReadSideRun;
  }) => ExecutionProfileResponse;
  projectMessagesContext: (input: {
    workspaceId: string;
    sessionId: string;
    session: ReadSideSession;
    appendMessage?: { role: "system" | "user"; content: string };
  }) => Promise<MessagesContextResponse>;
  projectPromptContext: (input: {
    workspaceId: string;
    sessionId: string;
    session: ReadSideSession;
    run: ReadSideRun;
  }) => Promise<PromptContextResponse>;
};

export class ReadSideApplication<ExecutionProfileResponse, MessagesContextResponse, PromptContextResponse> {
  constructor(private readonly dependencies: ReadSideApplicationDependencies<ExecutionProfileResponse, MessagesContextResponse, PromptContextResponse>) {}

  getExecutionProfileForRun(input: AgentApiExecutionProfileRequest) {
    const { session, run } = this.requireRunContext(input);
    return this.dependencies.resolveExecutionProfile({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      session,
      run
    });
  }

  async getMessagesContext(input: AgentApiMessagesContextRequest) {
    const session = this.requireSession(input);
    return this.dependencies.projectMessagesContext({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      session,
      ...(input.appendMessage ? { appendMessage: input.appendMessage } : {})
    });
  }

  getPromptContextForRun(input: AgentApiPromptContextRequest) {
    const session = this.requireSession(input);
    this.dependencies.ensureWorkspace(input.workspaceId);
    const run = this.requireRun(input);
    return this.dependencies.projectPromptContext({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      session,
      run
    });
  }

  private requireSession(input: { workspaceId: string; sessionId: string }) {
    const session = this.dependencies.findSession(input.sessionId);
    if (!session) throw new HttpError(404, "session not found");
    if (session.workspaceId !== input.workspaceId) throw new HttpError(400, "workspaceId mismatch");
    return session;
  }

  private requireRunContext(input: AgentApiExecutionProfileRequest) {
    return { session: this.requireSession(input), run: this.requireRun(input) };
  }

  private requireRun(input: AgentApiExecutionProfileRequest) {
    const run = this.dependencies.findRun(input.runId);
    if (!run || run.sessionId !== input.sessionId || run.workspaceId !== input.workspaceId) {
      throw new HttpError(404, "run not found");
    }
    return run;
  }
}
