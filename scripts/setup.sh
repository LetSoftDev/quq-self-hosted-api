#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
OS_ID="unknown"
OS_NAME="Unknown OS"
OS_FAMILY="unknown"

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

info() {
  printf '%s\n' "$1"
}

warn() {
  printf 'Warning: %s\n' "$1"
}

manual_install_hint() {
  local tool="$1"
  local hint="$2"

  printf '\n'
  printf '%s was not installed automatically.\n' "$tool"
  printf '%s\n' "$hint"
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

read_env_value() {
  local key="$1"

  if [[ ! -f "$ENV_FILE" ]]; then
    return 1
  fi

  awk -F '=' -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      gsub(/^'\''|'\''$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

install_dependencies() {
  if [[ -f package-lock.json ]]; then
    note "Installing exact dependencies with npm ci."
    npm ci
  else
    warn "package-lock.json is missing; using npm install instead of npm ci."
    npm install
  fi
}

nginx_size_from_bytes() {
  local bytes="$1"

  if [[ ! "$bytes" =~ ^[0-9]+$ || "$bytes" -le 0 ]]; then
    printf '50m'
    return
  fi

  if (( bytes % 1048576 == 0 )); then
    printf '%sm' "$((bytes / 1048576))"
    return
  fi

  if (( bytes % 1024 == 0 )); then
    printf '%sk' "$((bytes / 1024))"
    return
  fi

  printf '%s' "$bytes"
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

sudo_cmd() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    printf 'sudo is required to run: %s\n' "$*" >&2
    return 1
  fi
}

enable_service_if_available() {
  local service_name="$1"

  if command -v systemctl >/dev/null 2>&1; then
    sudo_cmd systemctl enable --now "$service_name" 2>/dev/null || true
    return
  fi

  if command -v service >/dev/null 2>&1; then
    sudo_cmd service "$service_name" start 2>/dev/null || true
  fi
}

docker_compose_available() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

docker_available() {
  command -v docker >/dev/null 2>&1
}

print_manual_docker_commands() {
  local port="${1:-3000}"

  printf '\n'
  bold "Manual Docker setup"
  case "$OS_FAMILY" in
    debian)
      printf 'Run these commands, then check the API again:\n'
      printf '  apt update\n'
      printf '  apt install -y docker.io docker-compose-v2\n'
      printf '  systemctl enable --now docker\n'
      printf '  docker compose up -d --build\n'
      printf '  docker compose ps\n'
      printf '  curl http://localhost:%s/health\n' "$port"
      printf '\n'
      printf 'If docker-compose-v2 is not available on this server, install the legacy package instead:\n'
      printf '  apt install -y docker.io docker-compose\n'
      ;;
    rhel)
      printf 'Install Docker Engine for your RHEL-compatible distribution, then run:\n'
      printf '  systemctl enable --now docker\n'
      printf '  docker compose up -d --build\n'
      printf '  docker compose ps\n'
      printf '  curl http://localhost:%s/health\n' "$port"
      ;;
    arch)
      printf 'Run these commands, then check the API again:\n'
      printf '  pacman -Sy --noconfirm docker docker-compose\n'
      printf '  systemctl enable --now docker\n'
      printf '  docker compose up -d --build\n'
      printf '  docker compose ps\n'
      printf '  curl http://localhost:%s/health\n' "$port"
      ;;
    alpine)
      printf 'Run these commands, then check the API again:\n'
      printf '  apk add --no-cache docker docker-cli-compose\n'
      printf '  service docker start\n'
      printf '  docker compose up -d --build\n'
      printf '  docker compose ps\n'
      printf '  curl http://localhost:%s/health\n' "$port"
      ;;
    *)
      printf 'Install Docker Engine with the Compose plugin for your Linux distribution, then run:\n'
      printf '  docker --version\n'
      printf '  docker compose version\n'
      printf '  docker compose up -d --build\n'
      printf '  docker compose ps\n'
      printf '  curl http://localhost:%s/health\n' "$port"
      ;;
  esac
}

print_manual_node_commands() {
  printf '\n'
  bold "Manual Node.js setup"
  case "$OS_FAMILY" in
    debian)
      printf 'Run these commands, then rerun this wizard or choose PM2 again:\n'
      printf '  apt update\n'
      printf '  apt install -y ca-certificates curl gnupg\n'
      printf '  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -\n'
      printf '  apt install -y nodejs\n'
      printf '  node --version\n'
      printf '  npm --version\n'
      ;;
    arch)
      printf 'Run these commands, then rerun this wizard or choose PM2 again:\n'
      printf '  pacman -Sy --needed --noconfirm nodejs npm\n'
      printf '  node --version\n'
      printf '  npm --version\n'
      ;;
    alpine)
      printf 'Run these commands, then rerun this wizard or choose PM2 again:\n'
      printf '  apk add --no-cache nodejs npm\n'
      printf '  node --version\n'
      printf '  npm --version\n'
      ;;
    *)
      printf 'Install Node.js 20+ and npm for your Linux distribution, then run:\n'
      printf '  node --version\n'
      printf '  npm --version\n'
      ;;
  esac
}

print_manual_pm2_commands() {
  printf '\n'
  bold "Manual PM2 setup"
  printf 'Run these commands after Node.js and npm are available:\n'
  printf '  npm install -g pm2\n'
  printf '  npm install\n'
  printf '  npm run build\n'
  printf '  pm2 start ecosystem.config.cjs --update-env\n'
  printf '  pm2 save\n'
  printf '  npm run health\n'
}

print_manual_nginx_commands() {
  local domain="${1:-files.example.com}"
  local local_port="${2:-3000}"
  local client_max_body_size="${3:-50m}"

  printf '\n'
  bold "Manual Nginx setup"
  case "$OS_FAMILY" in
    debian)
      printf 'Run these commands:\n'
      printf '  apt update\n'
      printf '  apt install -y nginx\n'
      printf '  systemctl enable --now nginx\n'
      ;;
    arch)
      printf 'Run these commands:\n'
      printf '  pacman -Sy --needed --noconfirm nginx\n'
      printf '  systemctl enable --now nginx\n'
      ;;
    alpine)
      printf 'Run these commands:\n'
      printf '  apk add --no-cache nginx\n'
      printf '  service nginx start\n'
      ;;
    *)
      printf 'Install nginx for your Linux distribution and start the service.\n'
      ;;
  esac
  printf 'Then configure a reverse proxy for %s to http://127.0.0.1:%s with client_max_body_size %s.\n' "$domain" "$local_port" "$client_max_body_size"
  printf 'After configuring nginx, run:\n'
  printf '  nginx -t\n'
  printf '  systemctl reload nginx\n'
}

print_manual_certbot_commands() {
  local domain="${1:-files.example.com}"

  printf '\n'
  bold "Manual HTTPS setup"
  case "$OS_FAMILY" in
    debian)
      printf 'Run these commands after DNS points to this server:\n'
      printf '  apt update\n'
      printf '  apt install -y certbot python3-certbot-nginx\n'
      printf '  certbot --nginx -d %s\n' "$domain"
      ;;
    *)
      printf 'Install certbot and the nginx plugin for your Linux distribution, then run:\n'
      printf '  certbot --nginx -d %s\n' "$domain"
      ;;
  esac
}

print_manual_dns_commands() {
  local domain="$1"
  local server_ip="$2"

  printf '\n'
  bold "Manual DNS setup"
  if [[ -n "$server_ip" ]]; then
    printf 'Create or update this DNS record at your domain provider:\n'
    printf '  Type: A\n'
    printf '  Name: %s\n' "$domain"
    printf '  Value: %s\n' "$server_ip"
  else
    printf 'Create an A record for %s that points to this server public IPv4 address.\n' "$domain"
  fi
  printf 'After DNS propagates, rerun this wizard and choose nginx setup again.\n'
}

detect_os() {
  local kernel
  kernel="$(uname -s 2>/dev/null || printf 'unknown')"

  case "$kernel" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      OS_ID="windows"
      OS_NAME="Windows"
      OS_FAMILY="windows"
      return
      ;;
    Darwin)
      OS_ID="darwin"
      OS_NAME="macOS"
      OS_FAMILY="darwin"
      return
      ;;
  esac

  if [[ -r /proc/version ]] && grep -qiE 'microsoft|wsl' /proc/version; then
    OS_ID="wsl"
    OS_NAME="Windows Subsystem for Linux"
    OS_FAMILY="windows"
    return
  fi

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_NAME="${PRETTY_NAME:-${NAME:-Unknown Linux}}"
    local id_like=" ${ID_LIKE:-} "

    case "$OS_ID" in
      debian|ubuntu)
        OS_FAMILY="debian"
        ;;
      rhel|centos|rocky|almalinux|fedora|amzn)
        OS_FAMILY="rhel"
        ;;
      arch|manjaro)
        OS_FAMILY="arch"
        ;;
      alpine)
        OS_FAMILY="alpine"
        ;;
      *)
        if [[ "$id_like" == *" debian "* ]]; then
          OS_FAMILY="debian"
        elif [[ "$id_like" == *" rhel "* || "$id_like" == *" fedora "* ]]; then
          OS_FAMILY="rhel"
        elif [[ "$id_like" == *" arch "* ]]; then
          OS_FAMILY="arch"
        else
          OS_FAMILY="unknown"
        fi
        ;;
    esac
    return
  fi

  if [[ "$kernel" == "Linux" ]]; then
    OS_ID="linux"
    OS_NAME="Unknown Linux"
    OS_FAMILY="unknown"
  fi
}

ensure_supported_server_os() {
  section "System check"
  info "This wizard is intended for Linux servers. Windows Server is not supported for production self-hosting."
  detect_os
  note "Detected OS: $OS_NAME"

  if [[ "$OS_FAMILY" == "windows" ]]; then
    printf '\n'
    printf 'Windows Server and Windows-like shells are not supported by this self-hosted API wizard.\n'
    printf 'Use a Linux server instead. Recommended: Ubuntu or Debian.\n'
    exit 1
  fi

  if [[ "$OS_FAMILY" == "darwin" ]]; then
    warn "macOS is detected. The wizard can write project config, but automatic server package installation is disabled."
    return
  fi

  if [[ "$OS_FAMILY" == "unknown" ]]; then
    warn "This Linux distribution is not recognized. The wizard will keep manual install fallbacks for missing tools."
    return
  fi

  note "Linux family: $OS_FAMILY"
}

install_packages() {
  local packages=("$@")

  case "$OS_FAMILY" in
    debian)
      sudo_cmd apt-get update
      sudo_cmd apt-get install -y "${packages[@]}"
      ;;
    rhel)
      if command -v dnf >/dev/null 2>&1; then
        sudo_cmd dnf install -y "${packages[@]}"
      elif command -v yum >/dev/null 2>&1; then
        sudo_cmd yum install -y "${packages[@]}"
      else
        printf 'dnf or yum is required for automatic installation on this system.\n'
        return 1
      fi
      ;;
    arch)
      sudo_cmd pacman -Sy --needed --noconfirm "${packages[@]}"
      ;;
    alpine)
      sudo_cmd apk add --no-cache "${packages[@]}"
      ;;
    *)
      printf 'Automatic package installation is not available for %s.\n' "$OS_NAME"
      printf 'Install manually: %s\n' "${packages[*]}"
      return 1
      ;;
  esac
}

package_list() {
  local group="$1"

  case "$group:$OS_FAMILY" in
    base:debian) printf 'ca-certificates curl gnupg' ;;
    base:rhel) printf 'ca-certificates curl gnupg2' ;;
    base:arch) printf 'ca-certificates curl gnupg' ;;
    base:alpine) printf 'ca-certificates curl gnupg' ;;
    node:debian) printf 'nodejs' ;;
    node:rhel) printf 'nodejs npm' ;;
    node:arch) printf 'nodejs npm' ;;
    node:alpine) printf 'nodejs npm' ;;
    nginx:*) printf 'nginx' ;;
    certbot:debian) printf 'certbot python3-certbot-nginx' ;;
    certbot:rhel) printf 'certbot python3-certbot-nginx' ;;
    certbot:arch) printf 'certbot certbot-nginx' ;;
    certbot:alpine) printf 'certbot certbot-nginx' ;;
    docker:arch) printf 'docker docker-compose' ;;
    docker:alpine) printf 'docker docker-cli-compose' ;;
    *) return 1 ;;
  esac
}

install_package_group() {
  local group="$1"
  local packages

  if ! packages="$(package_list "$group")"; then
    printf 'No automatic package mapping for %s on %s.\n' "$group" "$OS_NAME"
    return 1
  fi

  # shellcheck disable=SC2086
  install_packages $packages
}

install_node() {
  info "Node.js and npm are required when running this API directly with PM2."
  info "The wizard selects install commands based on the detected Linux distribution."

  if ! yes_no "Install Node.js and npm now?" "y"; then
    manual_install_hint "Node.js" "Install Node.js and npm manually, then rerun this wizard or choose PM2 again."
    print_manual_node_commands
    return 1
  fi

  case "$OS_FAMILY" in
    debian)
      install_package_group base
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo_cmd bash -
      sudo_cmd apt-get install -y nodejs
      ;;
    rhel)
      install_package_group base
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo_cmd bash -
      install_packages nodejs
      ;;
    arch|alpine)
      install_package_group node
      ;;
    *)
      manual_install_hint "Node.js" "Install Node.js 20+ and npm using your server package manager."
      print_manual_node_commands
      return 1
      ;;
  esac
}

ensure_node() {
  section "Node.js check"
  info "This step is needed for PM2 mode because the API is built and started directly with npm."

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    note "Node.js is installed: $(node --version)"
    note "npm is installed: $(npm --version)"
    return 0
  fi

  warn "Node.js or npm is not installed."
  if ! install_node; then
    print_manual_node_commands
    return 1
  fi
}

install_docker() {
  info "Docker is required for the container runtime."
  info "The wizard selects install commands based on the detected Linux distribution."

  if ! yes_no "Install Docker now?" "y"; then
    manual_install_hint "Docker" "Install Docker Engine with the Compose plugin manually, then run: docker compose up -d --build"
    return 1
  fi

  case "$OS_FAMILY" in
    debian|rhel)
      install_package_group base
      local installer="/tmp/quq-install-docker.sh"
      curl -fsSL https://get.docker.com -o "$installer"
      sudo_cmd sh "$installer"
      rm -f "$installer"
      ;;
    arch|alpine)
      install_package_group docker
      ;;
    *)
      manual_install_hint "Docker" "Install Docker Engine and Docker Compose for your OS, then run: docker compose up -d --build"
      return 1
      ;;
  esac

  enable_service_if_available docker

  if [[ "$(id -u)" -ne 0 ]]; then
    sudo_cmd usermod -aG docker "$USER" || true
    warn "Your user was added to the docker group. You may need to log out and back in before running docker without sudo."
  fi
}

ensure_docker() {
  section "Docker check"
  info "Docker Compose mode keeps the API in a container and uses restart: unless-stopped."
  info "The wizard checks Docker only because you selected Docker runtime."

  if docker_compose_available; then
    note "Docker is installed: $(docker --version)"
    note "Docker Compose is available: $(docker compose version)"
    return 0
  fi

  if docker_available; then
    warn "Docker is installed, but Docker Compose is not available."
  else
    warn "Docker is not installed."
  fi

  if ! install_docker; then
    return 1
  fi

  if docker_compose_available; then
    note "Docker Compose is ready."
    return 0
  fi

  manual_install_hint "Docker Compose" "Make sure both docker --version and docker compose version work, then run: docker compose up -d --build"
  return 1
}

get_public_ip() {
  local ip=""

  if command -v curl >/dev/null 2>&1; then
    ip="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
  fi

  if [[ -z "$ip" ]] && command -v dig >/dev/null 2>&1; then
    ip="$(dig +short myip.opendns.com @resolver1.opendns.com | tail -n 1)"
  fi

  printf '%s' "$ip"
}

resolve_domain_ips() {
  local domain="$1"

  if command -v dig >/dev/null 2>&1; then
    dig +short A "$domain" | grep -E '^[0-9.]+$' || true
    return
  fi

  if command -v nslookup >/dev/null 2>&1; then
    nslookup "$domain" 2>/dev/null | awk '/^Address: / { print $2 }' | grep -E '^[0-9.]+$' || true
    return
  fi

  if command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "$domain" | awk '{ print $1 }' | sort -u || true
  fi
}

ensure_nginx() {
  local domain="${1:-files.example.com}"
  local local_port="${2:-3000}"
  local client_max_body_size="${3:-50m}"

  section "Nginx check"
  info "Nginx exposes the API on your public domain and forwards traffic to the local Node server."
  info "The wizard checks Nginx only because you selected Nginx setup."

  if command -v nginx >/dev/null 2>&1; then
    note "Nginx is already installed."
    return 0
  fi

  warn "Nginx is not installed."
  if yes_no "Install Nginx now?" "y"; then
    if install_package_group nginx; then
      enable_service_if_available nginx
    else
      warn "Nginx automatic installation failed."
      print_manual_nginx_commands "$domain" "$local_port" "$client_max_body_size"
      return 1
    fi
  else
    manual_install_hint "Nginx" "Install nginx manually before configuring the reverse proxy, then rerun this wizard."
    print_manual_nginx_commands "$domain" "$local_port" "$client_max_body_size"
    return 1
  fi
}

ensure_certbot() {
  local domain="${1:-files.example.com}"

  section "Certbot check"
  info "Certbot is used only when you ask the wizard to issue a Let's Encrypt HTTPS certificate."
  info "Without it, Nginx can still run HTTP and you can configure TLS manually later."

  if command -v certbot >/dev/null 2>&1; then
    note "Certbot is already installed."
    return 0
  fi

  warn "Certbot is not installed."
  if yes_no "Install Certbot now?" "y"; then
    if ! install_package_group certbot; then
      warn "Certbot automatic installation failed."
      print_manual_certbot_commands "$domain"
      return 1
    fi
  else
    manual_install_hint "Certbot" "Install certbot and python3-certbot-nginx manually before issuing a Let's Encrypt certificate."
    print_manual_certbot_commands "$domain"
    return 1
  fi
}

write_nginx_config() {
  local domain="$1"
  local local_port="$2"
  local client_max_body_size="$3"
  local config_path="/etc/nginx/sites-available/quq-self-hosted-api"
  local enabled_path="/etc/nginx/sites-enabled/quq-self-hosted-api"
  local tmp_file

  tmp_file="$(mktemp)"
  cat > "$tmp_file" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $domain;

  client_max_body_size $client_max_body_size;

  location / {
    proxy_pass http://127.0.0.1:$local_port;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
EOF

  sudo_cmd mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  sudo_cmd cp "$tmp_file" "$config_path"
  rm -f "$tmp_file"
  sudo_cmd ln -sfn "$config_path" "$enabled_path"

  if sudo_cmd nginx -t; then
    sudo_cmd systemctl reload nginx 2>/dev/null || sudo_cmd service nginx reload
    note "Nginx reverse proxy configured for http://$domain"
  else
    printf 'Nginx config test failed. Review %s manually.\n' "$config_path" >&2
    return 1
  fi
}

domain_points_to_server() {
  local domain="$1"
  local server_ip="$2"
  local domain_ips="$3"

  [[ -n "$server_ip" && " $domain_ips " == *" $server_ip "* ]]
}

configure_nginx() {
  printf '\n'
  bold "Nginx setup"

  if ! yes_no "Configure nginx reverse proxy now?" "n"; then
    note "Skipped nginx setup."
    return
  fi

  local domain local_port max_file_size client_max_body_size server_ip domain_ips
  domain="$(prompt_required "Public domain, for example files.example.com")"
  local_port="$(read_env_value "PORT" || true)"
  local_port="${local_port:-3000}"
  max_file_size="$(read_env_value "MAX_FILE_SIZE" || true)"
  max_file_size="${max_file_size:-52428800}"
  client_max_body_size="$(nginx_size_from_bytes "$max_file_size")"

  note "Using local API port from .env: $local_port"
  note "Using nginx upload limit from .env MAX_FILE_SIZE: $client_max_body_size"

  server_ip="$(get_public_ip)"
  domain_ips="$(resolve_domain_ips "$domain" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

  if [[ -n "$server_ip" ]]; then
    note "Server public IP: $server_ip"
  else
    note "Could not detect server public IP automatically."
  fi

  if [[ -n "$domain_ips" ]]; then
    note "$domain A record(s): $domain_ips"
  else
    note "Could not resolve A records for $domain."
  fi

  if ! domain_points_to_server "$domain" "$server_ip" "$domain_ips"; then
    printf '\n'
    printf 'DNS does not appear to point %s to this server yet.\n' "$domain"
    if [[ -n "$server_ip" ]]; then
      printf 'Create or update an A record: %s -> %s\n' "$domain" "$server_ip"
    else
      printf 'Create an A record that points %s to this server public IP.\n' "$domain"
    fi
    printf 'After DNS propagates, rerun this wizard before issuing a certificate.\n'
    print_manual_dns_commands "$domain" "$server_ip"

    if ! yes_no "Continue with HTTP-only nginx config anyway?" "n"; then
      return
    fi
  fi

  ensure_nginx "$domain" "$local_port" "$client_max_body_size" || return
  if ! write_nginx_config "$domain" "$local_port" "$client_max_body_size"; then
    print_manual_nginx_commands "$domain" "$local_port" "$client_max_body_size"
    return
  fi

  if yes_no "Issue Let's Encrypt HTTPS certificate now?" "y"; then
    if ! domain_points_to_server "$domain" "$server_ip" "$domain_ips"; then
      printf 'Skipping certificate because DNS is not confirmed for this server.\n'
      printf 'Fix DNS, then run: certbot --nginx -d %s\n' "$domain"
      print_manual_dns_commands "$domain" "$server_ip"
      print_manual_certbot_commands "$domain"
      return
    fi

    ensure_certbot "$domain" || return
    if ! sudo_cmd certbot --nginx -d "$domain"; then
      warn "Certbot failed to issue a certificate."
      print_manual_certbot_commands "$domain"
      return
    fi
  else
    note "Issue HTTPS later with: certbot --nginx -d $domain"
    print_manual_certbot_commands "$domain"
  fi
}

ensure_pm2() {
  section "PM2 check"
  info "PM2 keeps the API process alive when you run the server directly on Node.js."
  info "It can restart the API after crashes and can be configured to start after server reboot."

  if command -v pm2 >/dev/null 2>&1; then
    note "PM2 is already installed."
    return
  fi

  warn "PM2 is not installed."
  if yes_no "Install PM2 globally now?" "y"; then
    if command -v npm >/dev/null 2>&1; then
      if ! npm install -g pm2; then
        warn "PM2 automatic installation failed."
        print_manual_pm2_commands
        return 1
      fi
    else
      manual_install_hint "PM2" "npm is required. Install Node.js/npm first, then run: npm install -g pm2"
      print_manual_node_commands
      print_manual_pm2_commands
      return 1
    fi
  else
    manual_install_hint "PM2" "Install PM2 manually before starting the app: npm install -g pm2"
    print_manual_pm2_commands
    return 1
  fi
}

main() {
  cd "$ROOT_DIR"

  bold "QuqManager Self-Hosted API setup"
  info "This wizard prepares a public self-hosted API server step by step."
  info "It writes runtime config, prepares storage folders, checks required tools, and can configure a process manager plus Nginx."

  ensure_supported_server_os

  local port uploads_dir data_dir max_file_size node_env validation_secret
  section "Environment"
  info "These values control how the API listens locally and where uploaded files are stored."
  info "The wizard writes them to .env. You can edit that file manually later if needed."
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

  section "Runtime"
  info "Choose how this server will stay alive in production."
  info "Docker keeps everything inside a container. PM2 runs the built Node.js app directly on the server."
  printf '1) Docker Compose restart policy\n'
  printf '2) PM2 process manager\n'
  printf '3) Skip for now\n'

  local runtime runtime_status runtime_label
  runtime_status="not-started"
  runtime_label="No runtime"
  runtime="$(prompt "Select option" "1")"

  case "$runtime" in
    1)
      runtime_label="Docker Compose"
      if ensure_docker; then
        note "Docker Compose is already configured with restart: unless-stopped."
        if yes_no "Build and start Docker Compose now?" "y"; then
          if docker compose up -d --build; then
            runtime_status="started"
            note "Docker Compose started."
            docker compose ps
          else
            runtime_status="failed"
            warn "Docker Compose failed to start the API."
            note "Inspect the error above, then run: docker compose up -d --build"
          fi

          if [[ "$runtime_status" == "started" ]] && yes_no "Follow Docker logs now?" "n"; then
            docker compose logs -f api
          else
            note "Follow logs later with: docker compose logs -f api"
          fi
        else
          runtime_status="deferred"
          note "Start later with: docker compose up -d --build"
          note "Follow logs later with: docker compose logs -f api"
        fi
      else
        runtime_status="missing-dependency"
        note "Docker runtime was not started."
        note "Install Docker and Docker Compose manually, then start the API."
        print_manual_docker_commands "$port"
        note "Follow logs later with: docker compose logs -f api"
      fi
      ;;
    2)
      local app_name
      runtime_label="PM2"
      if ensure_node; then
        app_name="$(prompt "PM2 app name" "quq-self-hosted-api")"
        ensure_pm2 || true
        write_pm2_ecosystem "$app_name"

        if command -v pm2 >/dev/null 2>&1 && yes_no "Install dependencies, build, and start with PM2 now?" "y"; then
          if ! install_dependencies; then
            runtime_status="failed"
            warn "Dependency installation failed."
            print_manual_pm2_commands
          elif ! npm run build; then
            runtime_status="failed"
            warn "Build failed."
            print_manual_pm2_commands
          elif pm2 start ecosystem.config.cjs --update-env; then
            runtime_status="started"
          else
            runtime_status="failed"
            warn "PM2 failed to start the API."
            print_manual_pm2_commands
          fi

          if [[ "$runtime_status" == "started" ]]; then
            if yes_no "Configure PM2 startup on boot now?" "y"; then
              pm2 startup
              printf '\n'
              printf 'Run the command printed by PM2 above if it asks for sudo access, then run:\n'
              printf 'pm2 save\n'
            else
              note "Skipped PM2 startup setup."
            fi
          fi

          if [[ "$runtime_status" == "started" ]] && yes_no "Save current PM2 process list now?" "y"; then
            pm2 save
          fi
        else
          runtime_status="deferred"
          note "Install and build later with: npm install && npm run build"
          note "Start later with: pm2 start ecosystem.config.cjs --update-env"
          note "Persist later with: pm2 startup && pm2 save"
          print_manual_pm2_commands
        fi
      else
        runtime_status="missing-dependency"
        note "PM2 runtime cannot continue until Node.js and npm are available."
        note "Install Node.js/npm manually, then rerun this wizard or run npm install && npm run build later."
        print_manual_node_commands
        print_manual_pm2_commands
      fi
      ;;
    3)
      runtime_label="Skipped"
      runtime_status="deferred"
      note "Skipped process manager setup."
      ;;
    *)
      runtime_label="Unknown"
      runtime_status="deferred"
      note "Unknown option. Skipped process manager setup."
      ;;
  esac

  configure_nginx

  printf '\n'
  bold "Next steps"
  printf 'Runtime selected: %s\n' "$runtime_label"
  case "$runtime_status" in
    started)
      printf '- The API runtime was started by this wizard.\n'
      printf '- Check health: npm run health\n'
      printf '  Or manually: curl http://localhost:%s/health\n' "$port"
      ;;
    deferred)
      printf '- The API was not started yet.\n'
      printf '  Docker: run docker compose up -d --build\n'
      printf '  PM2: run npm install && npm run build && pm2 start ecosystem.config.cjs --update-env\n'
      printf '- After starting it, check health: npm run health\n'
      ;;
    missing-dependency)
      printf '- The API was not started because a required runtime dependency is missing.\n'
      printf '  Docker mode requires: docker --version and docker compose version\n'
      printf '  PM2 mode requires: node --version, npm --version, and pm2 --version\n'
      printf '- Install the missing tool using the manual setup printed above, then rerun this wizard or start manually.\n'
      ;;
    failed)
      printf '- The selected runtime attempted to start but failed.\n'
      printf '- Inspect logs/errors:\n'
      printf '  Docker: docker compose logs -f api\n'
      printf '  PM2: pm2 logs quq-self-hosted-api\n'
      printf '- Retry health after fixing the runtime: npm run health\n'
      ;;
  esac
  printf '- Optional nginx setup can expose the API at: https://your-domain.example\n'
  printf '- Point frontend integrations to the public /api URL.\n'
}

main "$@"
