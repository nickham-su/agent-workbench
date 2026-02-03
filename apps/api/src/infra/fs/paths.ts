import path from "node:path";

export function dbPath(dataDir: string) {
  return path.join(dataDir, "db.sqlite");
}

export function reposRoot(dataDir: string) {
  return path.join(dataDir, "repos");
}

export function repoRoot(dataDir: string, repoId: string) {
  return path.join(reposRoot(dataDir), repoId);
}

export function repoMirrorPath(dataDir: string, repoId: string) {
  return path.join(repoRoot(dataDir, repoId), "mirror.git");
}

export function workspacesRoot(dataDir: string) {
  return path.join(dataDir, "workspaces");
}

export function workspaceRoot(dataDir: string, workspaceDirName: string) {
  return path.join(workspacesRoot(dataDir), workspaceDirName);
}

export function workspaceRepoDirPath(dataDir: string, workspaceDirName: string, dirName: string) {
  return path.join(workspaceRoot(dataDir, workspaceDirName), dirName);
}

export function tmpRoot(dataDir: string) {
  return path.join(dataDir, "tmp");
}

export function sshRoot(dataDir: string) {
  return path.join(dataDir, "ssh");
}

export function sshKnownHostsPath(dataDir: string) {
  return path.join(sshRoot(dataDir), "known_hosts");
}

export function certsRoot(dataDir: string) {
  return path.join(dataDir, "certs");
}

export function caCertPath(dataDir: string) {
  return path.join(certsRoot(dataDir), "ca.pem");
}

export function caBundlePath(dataDir: string) {
  return path.join(certsRoot(dataDir), "ca-bundle.pem");
}

export function keysRoot(dataDir: string) {
  return path.join(dataDir, "keys");
}

export function credentialMasterKeyJsonPath(dataDir: string) {
  return path.join(keysRoot(dataDir), "credential-master-key.json");
}
