import type { AgentUiLocale } from "@agent-workbench/shared";

export type MessagesContextProjectorDependencies<Message> = {
  buildMessages: (input: { workspaceId: string; sessionId: string }) => Promise<{ messages: Message[] }>;
  getActiveRunId: (input: { workspaceId: string; sessionId: string }) => string | null;
  resolveUiLocale: (input: { workspaceId: string; sessionId: string; activeRunId: string | null }) => AgentUiLocale | null;
  buildOneShotSystem: (input: { uiLocale: AgentUiLocale | null }) => string;
};

/**
 * Projects the messages-context response after session ownership validation.
 * The response-only append message deliberately mutates only the locally built
 * array and never writes a context item.
 */
export class MessagesContextProjector<Message extends { role: "system" | "user" | "assistant" | "tool"; content: unknown }> {
  constructor(private readonly dependencies: MessagesContextProjectorDependencies<Message>) {}

  async getMessagesContext(input: {
    workspaceId: string;
    sessionId: string;
    headItemId: number | null;
    appendMessage?: { role: "system" | "user"; content: string };
  }) {
    const { messages } = await this.dependencies.buildMessages({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId
    });
    const uiLocale = this.dependencies.resolveUiLocale({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      activeRunId: this.dependencies.getActiveRunId({ workspaceId: input.workspaceId, sessionId: input.sessionId })
    });
    if (input.appendMessage?.content.trim()) {
      messages.push({ role: input.appendMessage.role, content: input.appendMessage.content } as Message);
    }
    return {
      headItemId: input.headItemId,
      messages,
      system: this.dependencies.buildOneShotSystem({ uiLocale })
    };
  }
}
