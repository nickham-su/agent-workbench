export type AgentRunCompletedEvent = {
  eventId: string;
  eventType: "agent.run.completed.v1";
  occurredAt: number;
  workspaceId: string;
  sessionId: string;
  runId: string;
  finalStatus: "completed" | "failed" | "cancelled";
};

type Listener = (event: AgentRunCompletedEvent) => void;

export class AgentRunCompletedEventHub {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: AgentRunCompletedEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failures; this is a best-effort in-memory broadcaster.
      }
    }
  }

  listenerCount() {
    return this.listeners.size;
  }
}

export function toSseEventChunk(event: AgentRunCompletedEvent) {
  const data = JSON.stringify(event);
  return `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${data}\n\n`;
}
