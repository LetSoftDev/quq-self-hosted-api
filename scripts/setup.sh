#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

bold() {
  printf '\033[1m%s\033[0m\n' "$1"
}

note() {
  printf '-> %s\n' "$1"
}

prompt() {
  local label="$1"
  local default_value="$2"
  local value

  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    printf '%s' "${value:-$default_value}"
  else
    read -r -p "$label: " value
    printf '%s' "$value"
  fi
}

prompt_required() {
  local label="$1"
  local value=""

  while [[ -z "$value" ]]; do
    read -r -p "$label: " value
    if [[ -z "$value" ]]; then
      printf 'This value is required.\n'
    fi
  done

  printf '%s' "$value"
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

write_env() {
  local port="$1"
  local uploads_dir="$2"
  local data_dir="$3"
  local max_file_size="$4"
  local node_env="$5"
  local validation_secret="$6"

  if [[ -f "$ENV_FILE" ]]; then
    local backup="$ENV_FILE.backup.$(date +%Y%m%d%H%M%S)"
    cp "$ENV_FILE" "$backup"
    note "Existing .env backed up to $backup"
  fi

  cat > "$ENV_FILE" <<EOF
PORT=$port
UPLOADS_DIR=$uploads_dir
DATA_DIR=$data_dir
MAX_FILE_SIZE=$max_file_size
NODE_ENV=$node_env
VALIDATION_SECRET=$validation_secret
EOF
}

write_pm2_ecosystem() {
  local app_name="$1"
  local ecosystem_file="$ROOT_DIR/ecosystem.config.cjs"

  cat > "$ecosystem_file" <<EOF
module.exports = {
  apps: [
    {
      name: '$app_name',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,
    },
  ],
}
EOF

  note "PM2 ecosystem file generated at $ecosystem_file"
}

ensure_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    note "PM2 is already installed."
    return
  fi

  if yes_no "PM2 is not installed. Install it globally now?" "y"; then
    if command -v pnpm >/dev/null 2>&1; then
      pnpm add -g pm2
    elif command -v npm >/dev/null 2>&1; then
      npm install -g pm2
    else
      printf 'Neither pnpm nor npm is available. Install PM2 manually: npm install -g pm2\n'
      return 1
    fi
  else
    printf 'Install PM2 manually before starting the app: npm install -g pm2\n'
    return 1
  fi
}

main() {
  cd "$ROOT_DIR"

  bold "QuqManager Self-Hosted API setup"
  printf 'This wizard creates .env, prepares local storage folders, and can configure PM2 keep-alive.\n\n'

  local port uploads_dir data_dir max_file_size node_env validation_secret
  port="$(prompt "Port" "3000")"
  uploads_dir="$(prompt "Uploads directory" "./uploads")"
  data_dir="./data"
  max_file_size="$(prompt "Max file size in bytes" "52428800")"
  node_env="$(prompt "Node environment" "production")"
  printf '\n'
  printf 'Validation Secret is available in the QuqManager dashboard:\n'
  printf 'Projects -> select project -> Settings -> Validation Secret\n'
  validation_secret="$(prompt_required "Validation Secret from project settings")"

  write_env "$port" "$uploads_dir" "$data_dir" "$max_file_size" "$node_env" "$validation_secret"
  mkdir -p "$uploads_dir" "$data_dir"

  note ".env written"
  note "Storage directories ready"

  printf '\n'
  bold "Runtime"
  printf 'Choose how this server will stay alive in production.\n'
  printf '1) Docker Compose restart policy\n'
  printf '2) PM2 process manager\n'
  printf '3) Skip for now\n'

  local runtime
  runtime="$(prompt "Select option" "1")"

  case "$runtime" in
    1)
      note "Docker Compose is already configured with restart: unless-stopped."
      note "Run: docker compose up -d --build"
      ;;
    2)
      local app_name
      app_name="$(prompt "PM2 app name" "quq-self-hosted-api")"
      ensure_pm2 || true
      write_pm2_ecosystem "$app_name"

      if command -v pm2 >/dev/null 2>&1 && yes_no "Install dependencies, build, and start with PM2 now?" "y"; then
        pnpm install
        pnpm build
        pm2 start ecosystem.config.cjs --update-env

        if yes_no "Configure PM2 startup on boot now?" "y"; then
          pm2 startup
          printf '\n'
          printf 'Run the command printed by PM2 above if it asks for sudo access, then run:\n'
          printf 'pm2 save\n'
        else
          note "Skipped PM2 startup setup."
        fi

        if yes_no "Save current PM2 process list now?" "y"; then
          pm2 save
        fi
      else
        note "Start later with: pm2 start ecosystem.config.cjs --update-env"
        note "Persist later with: pm2 startup && pm2 save"
      fi
      ;;
    3)
      note "Skipped process manager setup."
      ;;
    *)
      note "Unknown option. Skipped process manager setup."
      ;;
  esac

  printf '\n'
  bold "Next steps"
  printf '1. Build or start the API:\n'
  printf '   - Docker: docker compose up -d --build\n'
  printf '   - PM2: pnpm install && pnpm build && pm2 start ecosystem.config.cjs --update-env\n'
  printf '   - Manual: pnpm install && pnpm build && pnpm start\n'
  printf '2. Check health: curl http://localhost:%s/health\n' "$port"
  printf '3. Point frontend integrations to: http://localhost:%s/api\n' "$port"
}

main "$@"
