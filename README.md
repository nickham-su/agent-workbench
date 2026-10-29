# Agent Workbench

A remote development workbench for AI/CLI coding agents. Manage multiple workspaces and reconnectable terminals in a Web UI, supporting the full workflow: Agent execution → Change review → Commit & push.

## The Problem

As AI models become more capable, agents can handle increasingly complex tasks that take longer to complete. Developers need to run multiple agents in parallel and offload long-running tasks to remote machines. The traditional single local working directory no longer fits this workflow:

- **Parallelism bottleneck**: A single working directory cannot support multiple agents running in parallel
- **Session loss**: Agent processes are lost when the local terminal closes
- **Information fragmentation**: Architectures such as frontend-backend separation or microservices often correspond to multiple repositories, leading to scattered information

Agent Workbench provides: isolated workspaces, persistent terminal sessions, centralized Git change review, with one-click local startup and an easy path to running on a remote host.

---

## Documentation

- [中文说明](docs/README.zh-CN.md)
- [Workspace static preview deployment guide](docs/manual/workspace-static-preview-deployment.md)
- [Workspace static preview authoring guide](docs/manual/workspace-static-preview-authoring.md)

---

## Quick Start (Docker Compose)

**Prerequisites**: Docker Desktop (or Linux Docker Engine) + Compose v2

- Clone the repository

```bash
git clone https://github.com/nickham-su/agent-workbench.git
```

- Optional config (recommended)
  - Copy `.env.example` to `.env` and edit variables as needed (recommended)
  - If you skip this step, Docker Compose will use defaults from `docker-compose.yml` (Compose defaults),
    and any unspecified runtime parameters will fall back to application defaults.

- Start the service

```bash
docker compose up -d --build
```

**Build cache and diagnostics**

BuildKit reuses npm downloads and prebuilt binaries across builds while the same builder's cache is retained. This does not cache native compilation outputs or guarantee a faster first build. Both dependency steps print installation scripts and npm timings; the install step also records Node/npm versions.

To inspect detailed build logs without starting or restarting services:

```bash
docker compose --progress plain build
```

Compare individual step timings and total build wall time separately: BuildKit can run stages concurrently, so adding the two dependency-step times does not give the total build time. Build-time dependency auditing is disabled; run `npm audit` separately during development or CI.

**Agent startup recovery**

Startup recovery has no mode switch. Before the API listener starts, it only cleans temporary/orphan data. After `onListen`, it uses fenced recovery enqueue: only a Run that is still the Session's current active Run is enqueued again.

**Verify env injection (optional)**

```bash
docker compose exec agent-workbench printenv AWB_AGENT_WORKER_CONCURRENCY
docker compose exec agent-workbench printenv AWB_AGENT_LOOP_MAX_STEPS
```

**Access**

Default port is 4310. If you change `AWB_PORT` in `.env`, replace the port in the URLs below accordingly.

| URL | Description |
|-----|-------------|
| `http://127.0.0.1:4310/` | Web UI |
| `http://127.0.0.1:4310/api/health` | Health check |
| `http://127.0.0.1:4310/api/docs` | API docs |

**Terminal run configurations**

Reliable restart/close of configured services requires Linux (kernel 5.3+),
`/usr/bin/python3` (Python 3.9+ with `pidfd_open`/`pidfd_send_signal`), and Linux
child-subreaper support with procfs mounted. The Docker image already provides these prerequisites.
Missing capabilities fail explicitly instead of starting an untracked service.
Runs created before managed run controls were introduced must be stopped manually
and their terminal tab closed once before creating a new managed run. Already-orphaned services are not
guessed or killed by port. External service managers such as PM2/Docker retain
responsibility for services started through them.

After a full container or machine restart, existing terminal APIs clean stale runs
whose tmux sessions are absent, without waiting for the previous launcher. Runs
are identified by the kernel boot ID and PID 1 starttime. **The first upgrade to
this recovery behavior requires a full container or machine restart, not just an
API restart:** old terminal sessions without this identity will be treated as
stale; terminal configurations and workspace files are preserved. Use one API
instance per data directory and a private PID namespace (the default Compose
setup); do not share its data with another running container or machine.
Terminal listing deletes stopped session records only after all cleanup succeeds,
removing their tabs while preserving configurations; a later run gets a new session ID.

**Workspace Dev Ports**

To avoid reconfiguring `docker-compose.yml` for every new project, the default Compose setup also publishes a reserved local port range for services started inside workspaces (HTTP servers, RPC, etc.):

- Host port range: controlled by `AWB_WORKSPACE_PORT_RANGE` in `.env`, default `30000-30100`
- Container port range: same as above
- If the container fails to start due to a port conflict, change `AWB_WORKSPACE_PORT_RANGE` in `.env` and restart the container.

**Data Persistence**

Two named volumes are used by default:

| Volume | Container Path | Contents |
|--------|----------------|----------|
| `agent-workbench-data` | `/data` | SQLite, repo mirrors, worktrees, keys, etc. |
| `agent-workbench-home` | `/home/dev` | User config, SSH, toolchains, etc. |

> Note: `docker compose down -v` will delete volumes and all data.

**Optional Personal Startup Script**

To install tools needed only by you, create `~/awb-startup.sh` **inside the container** (`/home/dev/awb-startup.sh`), without changing the Dockerfile or Compose configuration. For example, open an editor:

```bash
docker compose exec agent-workbench nano /home/dev/awb-startup.sh
```

Example script to install the PostgreSQL client only when missing:

```bash
#!/usr/bin/env bash
set -euo pipefail

if ! command -v psql >/dev/null 2>&1; then
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends postgresql-client
fi
```

The entrypoint runs this optional script with Bash as `dev`, after preparing the home/data directories and before starting the application. No executable permission is required. If the script is absent, startup proceeds normally; if it exits with a nonzero status, the application does not start and the container exits. With the default restart policy, Docker will retry startup. Only use scripts you trust: `dev` has passwordless `sudo` inside the container.

The script runs on **every container start**, including restarts and recreations during upgrades, so keep it safe to run repeatedly. The home volume preserves the script across `git pull` + `docker compose up -d --build`, but system packages installed with `apt-get` are lost when the container is recreated. Check for the actual tool rather than storing an “installed” marker in the persistent home directory. Network or package installation failures can prevent startup.

After saving the script, restart the container to run it, then inspect its output:

```bash
docker compose restart agent-workbench
docker compose logs -f agent-workbench
```

A script in the **host's** home directory is not automatically available inside the container. This hook runs at container startup, not on each terminal session or application-only restart.

**Security**

The Compose file publishes `AWB_PORT`, `AWB_PREVIEW_PORT` (default `4311`), and `AWB_WORKSPACE_PORT_RANGE` on all interfaces by default for convenience
(when no `.env` is provided). The recommended `.env.example` template binds main and preview ports to localhost (`AWB_PUBLISH_HOST=127.0.0.1`, `AWB_PREVIEW_PUBLISH_HOST=127.0.0.1`).
If you deploy this on a remote host, prefer a safer exposure model:

- Bind to localhost via `.env`: `AWB_PUBLISH_HOST=127.0.0.1`
- Put Nginx/Caddy in front as an HTTPS reverse proxy
- When preview is enabled, keep `AWB_PREVIEW_PUBLISH_HOST=127.0.0.1` and expose its independent preview domain only through a dedicated HTTPS reverse-proxy route
- Enable `AWB_AUTH_TOKEN` as a minimal auth guard, and set `AWB_AUTH_COOKIE_SECURE=1` when served over HTTPS
- Be cautious exposing `AWB_WORKSPACE_PORT_RANGE`, since it publishes ports for services started inside workspaces (shrink the range, or remove the mapping in your own compose setup if you don't need it)

If you need to publish ports to LAN/public directly, use `AWB_PUBLISH_HOST=0.0.0.0` and apply firewall rules + auth accordingly.

**Environment Variables**

> Note: Docker Compose `.env` is mainly for variable substitution. Only variables explicitly
> injected via `docker-compose.yml` `services.<name>.environment` (or `env_file`) will be visible
> to the process inside the container.

| Variable | Description |
|----------|-------------|
| `AWB_DATA_DIR` | `.env.example`: `/data`; `.env.dev.example`: `.data`. Data root for DB/keys/workspaces. |
| `AWB_HOST` | `.env.example`: `0.0.0.0`; `.env.dev.example`: `127.0.0.1`. API listen host (Docker usually binds all interfaces in-container; local dev defaults to loopback). |
| `AWB_PORT` | `.env.example`: `4310`; `.env.dev.example`: `4310`. Web UI + API port. |
| `AWB_FILE_MAX_BYTES` | `.env.example`: `1048576`; `.env.dev.example`: `1048576`. Max bytes for file preview/compare. |
| `AWB_LOG_LEVEL` | API log level. One of `trace`, `debug`, `info` (default), `warn`, `error`, or `fatal`; restart the API after changing it. |
| `AWB_APP_VERSION` | Optional override for `/api/health` version (empty by default). |
| `AWB_SERVE_WEB` | `.env.example`: `1`; `.env.dev.example`: `0`. `1` = API serves built web assets (single-port mode); `0` = local dev usually uses Vite dev server. |
| `AWB_WEB_DIST_DIR` | `.env.example`: `/app/apps/web/dist`; `.env.dev.example`: `apps/web/dist`. Web static asset directory when `AWB_SERVE_WEB=1`. |
| `AWB_CREDENTIAL_MASTER_KEY` | Optional credential master key. If empty, generated on first start and stored at `AWB_DATA_DIR/keys/credential-master-key.json` (recommended to set explicitly for migration scenarios). |
| `AWB_AUTH_TOKEN` | Optional access token protection for Web UI/API (session cookie after sign-in). |
| `AWB_AUTH_COOKIE_SECURE` | Cookie `Secure` flag: use `1` under HTTPS; keep `0` for local HTTP dev. |
| `AWB_AGENT_WORKER_ENABLED` | Enable agent worker process (`1` by default). Set `0` to fall back to API in-process runtime (debug only). |
| `AWB_AGENT_WORKER_CONCURRENCY` | Worker concurrency: `.env.example` default `5`; `.env.dev.example` default `3`. Runs in the same session are still serialized. |
| `AWB_AGENT_LOOP_MAX_STEPS` | Max loop steps per run (default `128`; `<=0` means unlimited). |
| `AWB_AGENT_LOOP_REPEAT_TOOL_CALL_THRESHOLD` | Repeated tool-call threshold in loop (default `20`; `<=0` means unlimited). |
| `AWB_AGENT_DEBUG_DUMP` | Debug dump switch (`1` to enable). Writes one record per Agent Message under `<workspace>/.debug/agent_message_logs/`. |
| `AWB_TOOL_ERROR_STORE_ENABLED` | Tool failure artifact switch (default `0`; only exact value `1` enables it). Writes complete parameters, results, and errors for non-cancelled tool failures under `<workspace>/.awb/agent/tool-errors/` for diagnostics. |
| Startup recovery | No environment variable. Startup performs pre-listen cleanup, then fenced recovery enqueue after `onListen` for Runs that remain current and active. |
| `AWB_AGENT_PLUGIN_HOST_ENABLED` | Plugin host process switch (default `0`, disabled). |
| `AWB_AGENT_PLUGIN_HOST_DEV` | Plugin host dev mode switch (default `0`; `1` starts plugin host from source). |
| `AWB_AGENT_PLUGIN_SERVICES_ENABLED` | Plugin services registry/call switch (default `0`, disabled). |

**Workspace static preview**

Preview is disabled by default. Enabling it requires an independent public origin and a second listener; do not reuse the main origin or a main-site subpath. See the [deployment guide](docs/manual/workspace-static-preview-deployment.md) for local, Compose, and dual-domain reverse-proxy examples.

| Variable | Description |
|----------|-------------|
| `AWB_PREVIEW_ENABLED` | Enables the isolated preview listener (default `false`). |
| `AWB_PREVIEW_ORIGIN` | Required when enabled: independent pure `http(s)` public origin, without path/query/fragment. |
| `AWB_PREVIEW_HOST` / `AWB_PREVIEW_PORT` | Preview listener host and port (default port `4311`); it must not use the main API port. |
| `AWB_PREVIEW_SESSION_TTL_SECONDS` | Absolute preview session TTL in seconds (`60..86400`, default `3600`). |

**Docker / Compose only (`.env.example`)**

| Variable | Description |
|----------|-------------|
| `AWB_PUBLISH_HOST` | Host bind IP for published ports. Default `127.0.0.1`; use `0.0.0.0` only with firewall/auth/reverse-proxy protections. |
| `AWB_WORKSPACE_PORT_RANGE` | Published workspace service port range (default `30000-30100`). |
| `AWB_PREVIEW_PUBLISH_HOST` | Host bind IP for the Compose preview port. Keep `127.0.0.1` when TLS terminates at a local reverse proxy. |

**Local source dev only (`.env.dev.example`)**

| Variable | Description |
|----------|-------------|
| `AWB_DEV_WEB_PORT` | Optional Vite dev server port (frontend dev only). |
| `AWB_DEV_API_ORIGIN` | Optional proxy target for frontend dev server (defaults to `http://127.0.0.1:${AWB_PORT}`). |
| `AWB_MAX_TERMINALS` | Reserved for global terminal-session limit (currently not implemented). |
| `AWB_AGENT_WORKER_HOST` | Worker listen host for local dev (default `127.0.0.1`). |
| `AWB_AGENT_WORKER_PORT` | Worker listen port for local dev (default `4312`). |
| `AWB_AGENT_WORKER_SOCKET` | Worker unix socket path (empty = auto at `AWB_DATA_DIR/agent-worker.sock`, preferred over TCP when available). |
| `AWB_AGENT_INTERNAL_TOKEN` | Internal API↔worker auth token (empty = auto-generated by API at startup and passed to worker). |
| `AWB_AGENT_API_ORIGIN` | Worker callback origin to API (usually keep empty for auto-derive). |

---

## Usage

- Add repositories in **Repos** (HTTPS/SSH supported). Configure credentials in **Settings** if authentication is required.
- Create a workspace from a repository and branch in **Workspaces**, then enter it.
- Run agents or execute build/test tasks in the terminal.
- Review staged/unstaged changes with side-by-side diff in the code review panel, then commit and push.

---

## Terminal Tips

**Selecting Text**

Text selection in the terminal requires a modifier key:

| Platform | Action |
|----------|--------|
| macOS | Hold `Option(⌥)` and drag to select |
| Windows / Linux | Hold `Shift` and drag to select |

Copy with `⌘C` (macOS) or `Ctrl+Shift+C` (Windows/Linux).

**Scrolling**

Use the mouse wheel to scroll through history. In fullscreen programs like `vim` or `top`, use the program's native scrolling.

---

## Local Development

**Prerequisites**

- Node.js 24 LTS (the repository includes `.nvmrc`; run `nvm use` if using nvm)
- `git`, `tmux`
- Build toolchain (macOS requires Xcode Command Line Tools for compiling `better-sqlite3` and `node-pty`)

**Start**

```bash
npm install
npm run dev
```

After switching Node.js major versions, stop the development services and rebuild native dependencies under Node.js 24 before restarting:

```bash
npm rebuild better-sqlite3 node-pty
```

Do not reuse native binaries built under another Node.js major version. Rebuilding dependencies does not require deleting application databases or `package-lock.json`.

**Local env**

- Copy `.env.dev.example` to `.env.local` and adjust variables as needed
  - `AWB_PORT`: backend listen port (default: `4310`)
  - `AWB_DEV_WEB_PORT`: Vite dev server port (optional)
  - `AWB_DEV_API_ORIGIN`: dev proxy target (optional, default: `http://127.0.0.1:${AWB_PORT}`)
  - For static preview, use the independent listener variables documented in the [deployment guide](docs/manual/workspace-static-preview-deployment.md).

**Scripts**

| Command | Description |
|---------|-------------|
| `npm run dev:api` | Start backend only |
| `npm run dev:web` | Start frontend only |
| `npm run build` | Production build |
| `npm run typecheck` | Type checking |

---
