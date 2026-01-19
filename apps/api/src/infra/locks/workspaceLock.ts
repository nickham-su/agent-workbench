type Unlock = () => void;

const tails = new Map<string, Promise<void>>();

function lockKey(params: { workspaceId: string }) {
  return params.workspaceId;
}

async function acquire(key: string): Promise<Unlock> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => gate);
  tails.set(key, tail);

  await prev;
  return () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
}

export async function withWorkspaceLock<T>(params: { workspaceId: string }, fn: () => Promise<T>): Promise<T> {
  const unlock = await acquire(lockKey(params));
  try {
    return await fn();
  } finally {
    unlock();
  }
}
