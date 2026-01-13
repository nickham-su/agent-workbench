import path from "node:path";
import { rmrf } from "../../infra/fs/fs.js";
import { tmpRoot } from "../../infra/fs/paths.js";

export function terminalSshKeyPath(dataDir: string, terminalId: string) {
  return path.join(tmpRoot(dataDir), `term-ssh-key-${terminalId}`);
}

export function terminalAskpassPath(dataDir: string, terminalId: string) {
  return path.join(tmpRoot(dataDir), `term-git-askpass-${terminalId}.sh`);
}

export function terminalAskpassTokenPath(dataDir: string, terminalId: string) {
  return path.join(tmpRoot(dataDir), `term-git-askpass-token-${terminalId}`);
}

export async function cleanupTerminalGitAuthArtifacts(dataDir: string, terminalId: string) {
  await Promise.all([
    rmrf(terminalSshKeyPath(dataDir, terminalId)),
    rmrf(terminalAskpassPath(dataDir, terminalId)),
    rmrf(terminalAskpassTokenPath(dataDir, terminalId))
  ]);
}
