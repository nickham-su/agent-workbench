# Agent Workbench

A local development workbench for AI/CLI coding agents. Manage multiple workspaces and reconnectable terminals in a Web UI, supporting the full workflow: Agent execution → Change review → Commit & push.

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
  - Copy `.env.docker.example` to `.env` and edit variables as needed
  - If you skip this step, Docker Compose will use defaults from `docker-compose.yml`

- Start the service

```bash
docker compose up -d --build
```

**Access**

Default port is 4310. If you change `PORT` in `.env`, replace the port in the URLs below accordingly.

| URL | Description |
|-----|-------------|
| `http://127.0.0.1:4310/` | Web UI |
| `http://127.0.0.1:4310/api/health` | Health check |
| `http://127.0.0.1:4310/api/docs` | API docs |

**Workspace Dev Ports**

To avoid reconfiguring `docker-compose.yml` for every new project, the default Compose setup also publishes a reserved local port range for services started inside workspaces (HTTP servers, RPC, etc.):

- Host port range: controlled by `WORKSPACE_PORT_RANGE` in `.env`, default `30000-30100`
- Container port range: same as above
- If the container fails to start due to a port conflict, change `WORKSPACE_PORT_RANGE` in `.env` and restart the container.

**Data Persistence**

Two named volumes are used by default:

| Volume | Container Path | Contents |
|--------|----------------|----------|
| `agent-workbench-data` | `/data` | SQLite, repo mirrors, worktrees, keys, etc. |
| `agent-workbench-home` | `/home/dev` | User config, SSH, toolchains, etc. |

> Note: `docker compose down -v` will delete volumes and all data.

**Security**

By default, for convenience, `PORT` and `WORKSPACE_PORT_RANGE` are published on all interfaces. If you deploy this on a remote host, prefer a safer exposure model:

- Bind to localhost via `.env`: `PUBLISH_HOST=127.0.0.1`
- Put Nginx/Caddy in front as an HTTPS reverse proxy
- Enable `AUTH_TOKEN` as a minimal auth guard, and set `AUTH_COOKIE_SECURE=1` when served over HTTPS
- Be cautious exposing `WORKSPACE_PORT_RANGE`, since it publishes ports for services started inside workspaces (shrink the range, or remove the mapping in your own compose setup if you don't need it)

If you need to publish ports to LAN/public directly, use `PUBLISH_HOST=0.0.0.0` and apply firewall rules + auth accordingly.

**Environment Variables**

| Variable | Description |
|----------|-------------|
| `PORT` | Published port for Web UI + API (default `4310`). |
| `WORKSPACE_PORT_RANGE` | Reserved workspace port range (default `30000-30100`) for publishing services started inside workspaces. |
| `CREDENTIAL_MASTER_KEY` | Encryption key for credentials (32-byte hex/base64/base64url). Auto-generated and saved to `/data/keys/credential-master-key.json` if not set. Recommended to set explicitly for migration scenarios. |
| `AUTH_TOKEN` | Optional access token protection. If set, Web UI/API requires signing in with this token (session cookie). |
| `AUTH_COOKIE_SECURE` | Set to `1` when serving over HTTPS (adds `Secure` to the session cookie). Keep `0` for local HTTP dev. |
| `PUBLISH_HOST` | Host IP to publish ports on (Docker Compose). Set `127.0.0.1` to allow localhost access only. |

Other Compose-related variables (e.g. `HOST`, `DATA_DIR`, `SERVE_WEB`, `WEB_DIST_DIR`) are documented in `.env.docker.example`.

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

- Copy `.env.example` to `.env.local` and adjust variables as needed
  - `PORT`: backend listen port (default: `4310`)
  - `DEV_WEB_PORT`: Vite dev server port (optional)
  - `DEV_API_ORIGIN`: dev proxy target (optional, default: `http://127.0.0.1:${PORT}`)

**Scripts**

| Command | Description |
|---------|-------------|
| `npm run dev:api` | Start backend only |
| `npm run dev:web` | Start frontend only |
| `npm run build` | Production build |
| `npm run typecheck` | Type checking |

---
