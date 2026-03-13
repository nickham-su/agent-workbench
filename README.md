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

---

## Quick Start (Docker Compose)

**Prerequisites**: Docker Desktop (or Linux Docker Engine) + Compose v2

- Clone the repository

```bash
git clone https://github.com/nickham-su/agent-workbench.git
```

- Optional config (recommended)
  - Copy `.env.example` to `.env` and edit variables as needed (recommended)
    - `.env.docker.example` is kept for compatibility and mirrors `.env.example`
  - If you skip this step, Docker Compose will use defaults from `docker-compose.yml` (Compose defaults),
    and any unspecified runtime parameters will fall back to application defaults.

- Start the service

```bash
docker compose up -d --build
```

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

**Security**

The Compose file publishes `AWB_PORT` and `AWB_WORKSPACE_PORT_RANGE` on all interfaces by default for convenience
(when no `.env` is provided). The recommended `.env.example` template binds them to localhost (`AWB_PUBLISH_HOST=127.0.0.1`).
If you deploy this on a remote host, prefer a safer exposure model:

- Bind to localhost via `.env`: `AWB_PUBLISH_HOST=127.0.0.1`
- Put Nginx/Caddy in front as an HTTPS reverse proxy
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
| `AWB_AGENT_DEBUG_DUMP` | Debug dump switch (`1` to enable). Writes per-context logs under `<workspace>/.debug/agent_context_item_logs/`. |
| `AWB_AGENT_STARTUP_RECOVERY_MODE` | Startup recovery mode: `fail` (default, mark inflight runs failed) or `recover` (resume inflight runs). |
| `AWB_AGENT_PLUGIN_HOST_ENABLED` | Plugin host process switch (default `0`, disabled). |
| `AWB_AGENT_PLUGIN_HOST_DEV` | Plugin host dev mode switch (default `0`; `1` starts plugin host from source). |
| `AWB_AGENT_PLUGIN_SERVICES_ENABLED` | Plugin services registry/call switch (default `0`, disabled). |

**Docker / Compose only (`.env.example`)**

| Variable | Description |
|----------|-------------|
| `AWB_PUBLISH_HOST` | Host bind IP for published ports. Default `127.0.0.1`; use `0.0.0.0` only with firewall/auth/reverse-proxy protections. |
| `AWB_WORKSPACE_PORT_RANGE` | Published workspace service port range (default `30000-30100`). |

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

- Node.js LTS (20.x or 22.x)
- `git`, `tmux`
- Build toolchain (macOS requires Xcode Command Line Tools for compiling `better-sqlite3` and `node-pty`)

**Start**

```bash
npm install
npm run dev
```

**Local env**

- Copy `.env.dev.example` to `.env.local` and adjust variables as needed
  - `AWB_PORT`: backend listen port (default: `4310`)
  - `AWB_DEV_WEB_PORT`: Vite dev server port (optional)
  - `AWB_DEV_API_ORIGIN`: dev proxy target (optional, default: `http://127.0.0.1:${AWB_PORT}`)

**Scripts**

| Command | Description |
|---------|-------------|
| `npm run dev:api` | Start backend only |
| `npm run dev:web` | Start frontend only |
| `npm run build` | Production build |
| `npm run typecheck` | Type checking |

---
