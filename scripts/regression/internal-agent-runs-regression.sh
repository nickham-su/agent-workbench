#!/usr/bin/env bash
set -euo pipefail

# 内部接口联调回归脚本（单路径方案）
# - triggerRun dedup
# - SSE event chunk
# - final-text query
#
# 依赖：jq, curl, node, npm

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

DATA_DIR="${AWB_REG_DATA_DIR:-$ROOT_DIR/.tmp-tests/regression-data}"
HOST="${AWB_REG_HOST:-127.0.0.1}"
PORT="${AWB_REG_PORT:-14310}"
WORKER_PORT="${AWB_REG_WORKER_PORT:-14312}"
INTERNAL_TOKEN="${AWB_REG_INTERNAL_TOKEN:-regression-internal-token}"
BASE_URL="http://${HOST}:${PORT}"

API_PID=""
WORKER_PID=""
cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" || true
  fi
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" || true
  fi
}
trap cleanup EXIT

mkdir -p "$DATA_DIR"
mkdir -p .tmp-tests

echo "[1/6] build..."
npm run build >/dev/null

echo "[2/6] start worker..."
AWB_DATA_DIR="$DATA_DIR" \
AWB_AGENT_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
AWB_AGENT_WORKER_PORT="$WORKER_PORT" \
AWB_AGENT_WORKER_HOST=127.0.0.1 \
AWB_LOG_LEVEL=error \
npm run start -w apps/agent-worker > .tmp-tests/reg-worker.log 2>&1 &
WORKER_PID=$!

sleep 2

echo "[3/6] start api (plugin-host on, web off)..."
AWB_DATA_DIR="$DATA_DIR" \
AWB_HOST="$HOST" \
AWB_PORT="$PORT" \
AWB_SERVE_WEB=0 \
AWB_AGENT_INTERNAL_TOKEN="$INTERNAL_TOKEN" \
AWB_AGENT_WORKER_ENABLED=1 \
AWB_AGENT_WORKER_HOST=127.0.0.1 \
AWB_AGENT_WORKER_PORT="$WORKER_PORT" \
AWB_AGENT_PLUGIN_HOST_ENABLED=1 \
AWB_AGENT_PLUGIN_SERVICES_ENABLED=1 \
AWB_LOG_LEVEL=error \
npm run start -w apps/api > .tmp-tests/reg-api.log 2>&1 &
API_PID=$!

for _ in $(seq 1 60); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "api process exited unexpectedly" >&2
    tail -n 80 .tmp-tests/reg-api.log >&2 || true
    exit 11
  fi
  if curl -sSf "$BASE_URL/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sSf "$BASE_URL/api/health" >/dev/null

echo "[4/6] configure minimal provider/agent..."
curl -sS -X PUT "$BASE_URL/api/settings/agent/providers" \
  -H 'content-type: application/json' \
  --data '{
    "providers": [{
      "id": "ppchat",
      "name": "ppchat",
      "npm": { "name": "@agent-infra/provider-openai", "version": "0.0.0-test" },
      "options": { "baseURL": "http://127.0.0.1:1", "apiKey": "test", "apiMode": "responses" },
      "models": [{ "id": "gpt-5.2", "name": "gpt-5.2", "contextWindowTokens": 128000 }]
    }]
  }' >/dev/null

curl -sS -X PUT "$BASE_URL/api/settings/agent/agents" \
  -H 'content-type: application/json' \
  --data '{
    "agents": [{
      "id": "default",
      "name": "default",
      "summary": "",
      "prompt": "You are a helpful coding assistant.",
      "tools": ["bash", "read", "write"],
      "pluginTools": [],
      "mcpServers": [],
      "defaultModel": null,
      "scope": "both",
      "order": 0
    }]
  }' >/dev/null

WORKSPACE_JSON=$(curl -sS -X POST "$BASE_URL/api/workspaces" \
  -H 'content-type: application/json' \
  --data '{"repoIds":[],"title":"regression"}')
WORKSPACE_ID=$(echo "$WORKSPACE_JSON" | jq -r '.id // empty')
if [[ -z "$WORKSPACE_ID" ]]; then
  echo "create workspace failed: $WORKSPACE_JSON" >&2
  exit 2
fi

SESSION_JSON=$(curl -sS -X POST "$BASE_URL/api/internal/agent/sessions/create" \
  -H "x-awb-agent-internal-token: $INTERNAL_TOKEN" \
  -H 'content-type: application/json' \
  --data "{\"workspaceId\":\"$WORKSPACE_ID\",\"title\":\"regression\"}")
SESSION_ID=$(echo "$SESSION_JSON" | jq -r '.id')
WORKSPACE_ID=$(echo "$SESSION_JSON" | jq -r '.workspaceId')

echo "[5/6] verify triggerRun dedup + SSE format + final-text API ..."
SSE_OUT=.tmp-tests/reg-sse.out
: > "$SSE_OUT"
curl -N -sS "$BASE_URL/api/internal/agent/events/sse" \
  -H "x-awb-agent-internal-token: $INTERNAL_TOKEN" > "$SSE_OUT" &
SSE_PID=$!
sleep 1

REQ='{"workspaceId":"'"$WORKSPACE_ID"'","sessionId":"'"$SESSION_ID"'","agentId":"default","text":"hello from regression","clientRequestId":"reg_req_1"}'
R1=$(curl -sS -X POST "$BASE_URL/api/internal/agent/runs/trigger" -H "x-awb-agent-internal-token: $INTERNAL_TOKEN" -H 'content-type: application/json' --data "$REQ")
R2=$(curl -sS -X POST "$BASE_URL/api/internal/agent/runs/trigger" -H "x-awb-agent-internal-token: $INTERNAL_TOKEN" -H 'content-type: application/json' --data "$REQ")

RUN_ID=$(echo "$R1" | jq -r '.runId')
DEDUP2=$(echo "$R2" | jq -r '.deduplicated')
if [[ "$DEDUP2" != "true" ]]; then
  echo "dedup check failed: $R2" >&2
  exit 3
fi

# 触发run-complete产生SSE事件（best-effort）
curl -sS -X POST "$BASE_URL/api/internal/agent/run-complete" \
  -H "x-awb-agent-internal-token: $INTERNAL_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"workspaceId":"'"$WORKSPACE_ID"'","sessionId":"'"$SESSION_ID"'","runId":"'"$RUN_ID"'","status":"completed"}' >/dev/null
sleep 1

if ! grep -q "event: agent.run.completed.v1" "$SSE_OUT"; then
  echo "SSE event type check failed" >&2
  exit 4
fi
if ! grep -q "\"runId\":\"$RUN_ID\"" "$SSE_OUT"; then
  echo "SSE runId check failed" >&2
  exit 5
fi

kill "$SSE_PID" || true

FINAL=$(curl -sS "$BASE_URL/api/internal/agent/runs/$RUN_ID/final-text" -H "x-awb-agent-internal-token: $INTERNAL_TOKEN")
echo "dedup second response: $R2"
echo "final-text response: $FINAL"

echo "[6/6] done ✅"

echo "logs: .tmp-tests/reg-api.log .tmp-tests/reg-worker.log"
