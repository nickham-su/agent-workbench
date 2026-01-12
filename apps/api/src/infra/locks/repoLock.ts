type AsyncFn<T> = () => Promise<T>;

const repoLocks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoId: string, fn: AsyncFn<T>): Promise<T> {
  const previous = repoLocks.get(repoId) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => next);
  repoLocks.set(repoId, chain);

  try {
    await previous;
    return await fn();
  } finally {
    release!();
    if (repoLocks.get(repoId) === chain) {
      repoLocks.delete(repoId);
    }
  }
}

