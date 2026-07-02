#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bold() {
  printf '\033[1m%s\033[0m\n' "$1"
}

section() {
  printf '\n'
  bold "$1"
}

note() {
  printf '%s\n' "-> $1"
}

warn() {
  printf 'Warning: %s\n' "$1"
}

yes_no() {
  local label="$1"
  local default_value="$2"
  local suffix="[y/N]"
  local value

  if [[ "$default_value" == "y" ]]; then
    suffix="[Y/n]"
  fi

  read -r -p "$label $suffix: " value
  value="${value:-$default_value}"

  [[ "$value" =~ ^[Yy]$ ]]
}

require_command() {
  local command_name="$1"
  local install_hint="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    return 0
  fi

  printf '%s is required.\n' "$command_name" >&2
  printf '%s\n' "$install_hint" >&2
  exit 127
}

ensure_git_repo() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return
  fi

  printf 'This directory is not a git repository. Cannot update source code automatically.\n' >&2
  exit 1
}

ensure_clean_tracked_changes() {
  if [[ -z "$(git status --porcelain --untracked-files=no)" ]]; then
    return
  fi

  printf 'Tracked files have local changes. Commit or stash them before updating.\n' >&2
  printf 'Untracked runtime files such as .env, uploads, and data are ignored by this check.\n' >&2
  git status --short --untracked-files=no >&2
  exit 1
}

pull_latest_code() {
  local branch upstream

  section "Source update"
  note "Fetching the latest repository state."
  git fetch --all --prune

  branch="$(git branch --show-current)"
  if [[ -z "$branch" ]]; then
    printf 'Detached HEAD is not supported by this update script.\n' >&2
    exit 1
  fi

  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ -z "$upstream" ]]; then
    printf 'Current branch "%s" has no upstream configured.\n' "$branch" >&2
    printf 'Set upstream with: git branch --set-upstream-to origin/%s %s\n' "$branch" "$branch" >&2
    exit 1
  fi

  note "Pulling $upstream with fast-forward only."
  git pull --ff-only
}

install_dependencies() {
  section "npm packages"
  note "Installing npm packages from the current lockfile."

  if [[ -f package-lock.json ]]; then
    npm ci
  else
    warn "package-lock.json is missing; using npm install instead of npm ci."
    npm install
  fi
}

build_project() {
  section "Build"
  note "Building the API before runtime restart."
  npm run build
}

restart_docker_if_requested() {
  if [[ ! -f docker-compose.yml ]]; then
    return
  fi

  section "Docker runtime"
  note "Use this if the API is running through Docker Compose."
  if yes_no "Rebuild and restart Docker Compose now?" "n"; then
    docker compose up -d --build
  else
    note "Skipped Docker restart. Run later: docker compose up -d --build"
  fi
}

restart_pm2_if_requested() {
  if [[ ! -f ecosystem.config.cjs ]]; then
    return
  fi

  section "PM2 runtime"
  note "Use this if the API is running directly with PM2."
  if ! command -v pm2 >/dev/null 2>&1; then
    warn "PM2 is not installed; skipped PM2 restart."
    note "Install PM2 later with: npm install -g pm2"
    return
  fi

  if yes_no "Restart PM2 process now?" "n"; then
    pm2 start ecosystem.config.cjs --update-env
    pm2 save
  else
    note "Skipped PM2 restart. Run later: pm2 start ecosystem.config.cjs --update-env && pm2 save"
  fi
}

run_health_check_if_requested() {
  section "Health check"
  note "This confirms that the API responds after the update."

  if yes_no "Run health check now?" "y"; then
    npm run health
  else
    note "Run later with: npm run health"
  fi
}

main() {
  cd "$ROOT_DIR"

  bold "QuqManager Self-Hosted API update"
  printf 'This script pulls the latest repository version, refreshes npm packages, builds the API, and can restart Docker or PM2.\n'
  printf 'It does not modify .env, uploads, or data.\n'

  require_command git "Install git using your server package manager."
  require_command npm "Install Node.js and npm, then rerun this script."
  ensure_git_repo
  ensure_clean_tracked_changes
  pull_latest_code
  install_dependencies
  build_project
  restart_docker_if_requested
  restart_pm2_if_requested
  run_health_check_if_requested

  printf '\n'
  bold "Update complete"
  note "Source code, npm packages, and build output are up to date."
}

main "$@"
