#!/usr/bin/env bash
set -euo pipefail

ensure_writable_dir() {
  local dir="${1}"

  if [ -z "${dir}" ] || [ ! -d "${dir}" ]; then
    return 0
  fi

  if [ -w "${dir}" ]; then
    return 0
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    echo "Directory is not writable and sudo is not installed: ${dir}" >&2
    exit 1
  fi

  echo "Directory is not writable; attempting to fix ownership: ${dir}" >&2
  sudo chown -R dev:dev "${dir}"

  if [ ! -w "${dir}" ]; then
    echo "Directory is still not writable (chown may be unsupported or it may be mounted read-only): ${dir}" >&2
    exit 1
  fi
}

ensure_writable_dir "${HOME:-}"
ensure_writable_dir "${AWB_DATA_DIR:-}"

mkdir -p "${NPM_CONFIG_PREFIX:-${HOME}/.npm-global}" "${NPM_CONFIG_CACHE:-${HOME}/.npm-cache}"

exec "$@"
