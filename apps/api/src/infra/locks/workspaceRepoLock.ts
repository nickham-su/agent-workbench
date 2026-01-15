type Unlock = () => void;

const tails = new Map<string, Promise<void>>();

function lockKey(params: { workspaceId: string; dirName: string }) {
  // key 仅用于进程内互斥，不参与持久化；要求稳定且可读即可
  return `${params.workspaceId}:${params.dirName}`;
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
    // 只有当没有更新的等待者时才清理，避免删掉别人的 tail
    if (tails.get(key) === tail) tails.delete(key);
  };
}

export async function withWorkspaceRepoLock<T>(
  params: { workspaceId: string; dirName: string },
  fn: () => Promise<T>
): Promise<T> {
  const unlock = await acquire(lockKey(params));
  try {
    return await fn();
  } finally {
    unlock();
  }
}

