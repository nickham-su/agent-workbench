type AsyncFn<T> = () => Promise<T>;

const workspaceLocks = new Map<string, Promise<unknown>>();

export async function withWorkspaceLock<T>(workspaceId: string, fn: AsyncFn<T>): Promise<T> {
  const previous = workspaceLocks.get(workspaceId) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => next);
  workspaceLocks.set(workspaceId, chain);

  try {
    await previous;
    return await fn();
  } finally {
    release!();
    if (workspaceLocks.get(workspaceId) === chain) {
      workspaceLocks.delete(workspaceId);
    }
  }
}
