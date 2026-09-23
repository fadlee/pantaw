#!/usr/bin/env bash
# Pantaw Agent installer
# Repository: https://github.com/fadlee/pantaw
#
# Interaktif (ditanya satu per satu):
#   curl -sSL https://raw.githubusercontent.com/fadlee/pantaw/main/install-agent.sh | sudo bash
#
# Non-interaktif (CI / provisioning):
#   curl -sSL .../install-agent.sh | sudo bash -s -- -u <HUB_URL> -t <TOKEN> -y
set -euo pipefail

REPO="fadlee/pantaw"
SERVICE_NAME="pantaw-agent"
CONFIG_DIR="/etc/pantaw"
ENV_FILE="$CONFIG_DIR/agent.env"
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"

VERSION="${VERSION:-latest}"
HUB_URL="${HUB_URL:-}"
AGENT_TOKEN="${AGENT_TOKEN:-}"
INTERVAL="${INTERVAL:-}"
DOCKER="${DOCKER:-}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
# Bisa diarahkan ke mirror / hosting sendiri; strukturnya harus sama dengan GitHub Releases
RELEASES_URL="${RELEASES_URL:-https://github.com/$REPO/releases}"
SERVICE="${SERVICE:-}" # yes | no | "" (tanya / auto)
ASSUME_YES=false
UNINSTALL=false

# ─── Output ───────────────────────────────────────────────────────────────────

if [ -t 2 ]; then
  C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_RESET=$'\033[0m'
else
  C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_RESET=""
fi

info() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*" >&2; }
ok() { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() {
  printf '%sError:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Pantaw Agent installer

Usage:
  curl -sSL https://raw.githubusercontent.com/$REPO/main/install-agent.sh | sudo bash
  curl -sSL https://raw.githubusercontent.com/$REPO/main/install-agent.sh | sudo bash -s -- [options]

Without options the installer asks for every value interactively.
Re-running it upgrades the binary and keeps the existing configuration.

Options:
  -u, --hub-url <url>      Pantaw Hub URL
  -t, --token <token>      Agent token (from the dashboard)
  -i, --interval <sec>     Reporting interval in seconds (default: 30, min: 5)
      --docker             Enable Docker container monitoring
      --no-docker          Disable Docker container monitoring
  -v, --version <tag>      Version to install (default: latest)
      --no-service         Install the binary only, do not set up systemd
  -y, --yes                Non-interactive: use flags/defaults, never prompt
      --uninstall          Stop and remove the service, binary and config
  -h, --help               Show this help

Environment variables HUB_URL, AGENT_TOKEN, INTERVAL, DOCKER, VERSION,
INSTALL_DIR and RELEASES_URL are honoured as well.
EOF
}

# ─── Argumen ──────────────────────────────────────────────────────────────────

need_arg() { [ $# -ge 2 ] && [ -n "$2" ] || die "option $1 needs a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -u | --hub-url) need_arg "$@"; HUB_URL="$2"; shift 2 ;;
    -t | --token) need_arg "$@"; AGENT_TOKEN="$2"; shift 2 ;;
    -i | --interval) need_arg "$@"; INTERVAL="$2"; shift 2 ;;
    -v | --version) need_arg "$@"; VERSION="$2"; shift 2 ;;
    --docker) DOCKER="true"; shift ;;
    --no-docker) DOCKER="false"; shift ;;
    --no-service) SERVICE="no"; shift ;;
    -y | --yes) ASSUME_YES=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ─── Privilege ────────────────────────────────────────────────────────────────

# Semua perintah yang menyentuh sistem lewat $SUDO, supaya jalur non-root + sudo
# konsisten (dulu binary dipasang pakai sudo tapi /etc ditulis tanpa sudo).
SUDO=""
HAS_PRIV=true
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    HAS_PRIV=false
  fi
fi

HAS_SYSTEMD=false
if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  HAS_SYSTEMD=true
fi

# ─── Prompt ───────────────────────────────────────────────────────────────────

# Saat dijalankan lewat `curl | bash`, stdin berisi script itu sendiri, jadi
# prompt harus membaca dari terminal langsung (/dev/tty).
INTERACTIVE=false
if [ "$ASSUME_YES" = false ] && { : </dev/tty; } 2>/dev/null; then
  INTERACTIVE=true
fi

# ask <var> <label> <default> [secret]
ask() {
  local __var="$1" label="$2" default="$3" secret="${4:-}" hint="" reply=""
  if [ -n "$default" ]; then
    if [ -n "$secret" ]; then hint=" ${C_DIM}[keep current]${C_RESET}"; else hint=" ${C_DIM}[$default]${C_RESET}"; fi
  fi
  printf '%s%s%s%s: ' "$C_BOLD" "$label" "$C_RESET" "$hint" >/dev/tty
  if [ -n "$secret" ]; then
    IFS= read -rs reply </dev/tty || true
    printf '\n' >/dev/tty
  else
    IFS= read -r reply </dev/tty || true
  fi
  printf -v "$__var" '%s' "${reply:-$default}"
}

# ask_yn <label> <default y|n> → exit status 0 untuk yes
ask_yn() {
  local label="$1" default="$2" reply="" hint="[y/N]"
  [ "$default" = "y" ] && hint="[Y/n]"
  while true; do
    printf '%s%s%s %s%s%s: ' "$C_BOLD" "$label" "$C_RESET" "$C_DIM" "$hint" "$C_RESET" >/dev/tty
    IFS= read -r reply </dev/tty || true
    case "${reply:-$default}" in
      y | Y | yes | YES) return 0 ;;
      n | N | no | NO) return 1 ;;
    esac
  done
}

# ─── Uninstall ────────────────────────────────────────────────────────────────

if [ "$UNINSTALL" = true ]; then
  [ "$HAS_PRIV" = true ] || die "uninstall needs root or sudo"
  if [ "$INTERACTIVE" = true ]; then
    ask_yn "Remove the Pantaw agent service, binary and $CONFIG_DIR?" n || exit 0
  fi
  if [ "$HAS_SYSTEMD" = true ] && [ -f "$UNIT_FILE" ]; then
    $SUDO systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    $SUDO rm -f "$UNIT_FILE"
    $SUDO systemctl daemon-reload
    ok "Service removed"
  fi
  $SUDO rm -f "$INSTALL_DIR/pantaw-agent"
  $SUDO rm -rf "$CONFIG_DIR"
  ok "Pantaw agent uninstalled"
  exit 0
fi

# ─── Konfigurasi ──────────────────────────────────────────────────────────────

# Jalankan ulang = upgrade: pakai konfigurasi yang sudah ada sebagai default.
EXISTING=false
if [ -e "$ENV_FILE" ] && { [ -r "$ENV_FILE" ] || { [ "$HAS_PRIV" = true ] && $SUDO test -r "$ENV_FILE"; }; }; then
  EXISTING=true
  while IFS='=' read -r key value; do
    case "$key" in
      HUB_URL) [ -n "$HUB_URL" ] || HUB_URL="$value" ;;
      AGENT_TOKEN) [ -n "$AGENT_TOKEN" ] || AGENT_TOKEN="$value" ;;
      INTERVAL) [ -n "$INTERVAL" ] || INTERVAL="$value" ;;
      DOCKER) [ -n "$DOCKER" ] || DOCKER="$value" ;;
    esac
  done < <($SUDO cat "$ENV_FILE" 2>/dev/null || true)
fi

DOCKER_SOCKET=false
[ -S /var/run/docker.sock ] && DOCKER_SOCKET=true

check_hub() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1/api/health" || true)
  [ "$code" = "200" ]
}

if [ "$INTERACTIVE" = true ]; then
  printf '\n%sPantaw Agent installer%s\n' "$C_BOLD" "$C_RESET" >/dev/tty
  if [ "$EXISTING" = true ]; then
    printf '%sExisting configuration found in %s — press Enter to keep a value.%s\n' "$C_DIM" "$ENV_FILE" "$C_RESET" >/dev/tty
  fi
  printf '\n' >/dev/tty

  while true; do
    ask HUB_URL "Hub URL" "$HUB_URL"
    HUB_URL="${HUB_URL%/}"
    case "$HUB_URL" in
      http://* | https://*) ;;
      "") warn "Hub URL is required"; continue ;;
      *) warn "Hub URL must start with http:// or https://"; continue ;;
    esac
    if check_hub "$HUB_URL"; then
      ok "Hub reachable"
      break
    fi
    warn "Could not reach $HUB_URL/api/health"
    ask_yn "Use this URL anyway?" n && break
  done

  while true; do
    ask AGENT_TOKEN "Agent token (input hidden)" "$AGENT_TOKEN" secret
    [ -n "$AGENT_TOKEN" ] && break
    warn "Agent token is required (copy it from Settings → Systems in the dashboard)"
  done

  while true; do
    ask INTERVAL "Reporting interval in seconds" "${INTERVAL:-30}"
    [[ "$INTERVAL" =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 5 ] && break
    warn "Interval must be a whole number of seconds, at least 5"
  done

  docker_default=n
  if [ "$DOCKER" = "true" ] || { [ -z "$DOCKER" ] && [ "$DOCKER_SOCKET" = true ]; }; then docker_default=y; fi
  if ask_yn "Monitor Docker containers?" "$docker_default"; then DOCKER=true; else DOCKER=false; fi
  if [ "$DOCKER" = true ] && [ "$DOCKER_SOCKET" = false ]; then
    warn "/var/run/docker.sock not found; container stats will be empty until Docker is running"
  fi

  if [ -z "$SERVICE" ]; then
    if [ "$HAS_SYSTEMD" = true ] && [ "$HAS_PRIV" = true ]; then
      if ask_yn "Install as a systemd service (starts on boot)?" y; then SERVICE=yes; else SERVICE=no; fi
    else
      SERVICE=no
    fi
  fi
else
  HUB_URL="${HUB_URL%/}"
  [ -n "$HUB_URL" ] || die "HUB_URL is required (use -u, or run in a terminal for interactive setup)"
  [ -n "$AGENT_TOKEN" ] || die "AGENT_TOKEN is required (use -t, or run in a terminal for interactive setup)"
  INTERVAL="${INTERVAL:-30}"
  [[ "$INTERVAL" =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 5 ] || die "INTERVAL must be an integer >= 5"
  DOCKER="${DOCKER:-false}"
  if [ -z "$SERVICE" ]; then
    if [ "$HAS_SYSTEMD" = true ] && [ "$HAS_PRIV" = true ]; then SERVICE=yes; else SERVICE=no; fi
  fi
fi

case "$DOCKER" in true | 1 | yes) DOCKER=true ;; *) DOCKER=false ;; esac

if [ "$SERVICE" = yes ] && [ "$HAS_SYSTEMD" = false ]; then
  warn "systemd not available on this machine; installing the binary only"
  SERVICE=no
fi

# ─── Platform ─────────────────────────────────────────────────────────────────

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux | darwin) ;;
  *) die "unsupported OS: $OS (Linux and macOS only)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

# Tanpa root/sudo, pasang di ~/.local/bin (kecuali INSTALL_DIR bisa ditulis).
if [ "$HAS_PRIV" = false ] && [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
fi
if [ -w "$INSTALL_DIR" ] || { [ ! -e "$INSTALL_DIR" ] && [ -w "$(dirname "$INSTALL_DIR")" ]; }; then
  BIN_SUDO=""
else
  BIN_SUDO="$SUDO"
fi
TARGET_BIN="$INSTALL_DIR/pantaw-agent"

# ─── Ringkasan ────────────────────────────────────────────────────────────────

if [ "$INTERACTIVE" = true ]; then
  masked="${AGENT_TOKEN:0:4}…${AGENT_TOKEN: -4}"
  [ "${#AGENT_TOKEN}" -le 8 ] && masked="********"
  cat >/dev/tty <<EOF

${C_BOLD}Summary${C_RESET}
  Hub URL    $HUB_URL
  Token      $masked
  Interval   ${INTERVAL}s
  Docker     $DOCKER
  Version    $VERSION
  Binary     $TARGET_BIN
  Service    $([ "$SERVICE" = yes ] && echo "systemd ($SERVICE_NAME)" || echo "no")

EOF
  ask_yn "Proceed?" y || die "aborted"
fi

# ─── Download ─────────────────────────────────────────────────────────────────

ASSET="pantaw-agent-${OS}-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  BASE="$RELEASES_URL/latest/download"
else
  BASE="$RELEASES_URL/download/$VERSION"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "Downloading $ASSET ($VERSION)"
curl -fsSL "$BASE/$ASSET" -o "$TMP_DIR/pantaw-agent" ||
  die "download failed: $BASE/$ASSET (see https://github.com/$REPO/releases)"

if curl -fsSL "$BASE/checksums.txt" -o "$TMP_DIR/checksums.txt" 2>/dev/null; then
  expected="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1 }' "$TMP_DIR/checksums.txt")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$TMP_DIR/pantaw-agent" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "$TMP_DIR/pantaw-agent" | awk '{ print $1 }')"
  fi
  [ -n "$expected" ] || die "$ASSET is not listed in checksums.txt"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $ASSET (expected $expected, got $actual)"
  ok "Checksum verified"
else
  warn "checksums.txt not found for this release; skipping checksum verification"
fi
chmod 755 "$TMP_DIR/pantaw-agent"
"$TMP_DIR/pantaw-agent" -version >/dev/null 2>&1 || die "downloaded binary does not run on this machine"

$BIN_SUDO mkdir -p "$INSTALL_DIR"
# install(1) menulis file baru lalu rename, aman walau binary lama sedang jalan
$BIN_SUDO install -m 755 "$TMP_DIR/pantaw-agent" "$TARGET_BIN"
ok "Installed $("$TARGET_BIN" -version 2>/dev/null || echo pantaw-agent) to $TARGET_BIN"

# ─── systemd ──────────────────────────────────────────────────────────────────

write_env() {
  # File berisi token: buat dengan umask ketat supaya tidak pernah world-readable
  $SUDO mkdir -p "$CONFIG_DIR"
  (umask 077 && cat >"$TMP_DIR/agent.env") <<EOF
HUB_URL=$HUB_URL
AGENT_TOKEN=$AGENT_TOKEN
INTERVAL=$INTERVAL
DOCKER=$DOCKER
LOG_LEVEL=info
EOF
  $SUDO install -m 600 "$TMP_DIR/agent.env" "$ENV_FILE"
}

if [ "$SERVICE" = yes ]; then
  info "Configuring systemd service"
  write_env

  cat >"$TMP_DIR/unit" <<EOF
[Unit]
Description=Pantaw Agent
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$TARGET_BIN
Restart=always
RestartSec=5s

# Sandboxing
ProtectSystem=full
ProtectHome=read-only
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  $SUDO install -m 644 "$TMP_DIR/unit" "$UNIT_FILE"

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
  # restart (bukan enable --now) supaya upgrade benar-benar memuat binary baru
  $SUDO systemctl restart "$SERVICE_NAME"

  sleep 3
  if $SUDO systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Service $SERVICE_NAME is running and starts on boot"
    printf '\n  Status:  systemctl status %s\n  Logs:    journalctl -u %s -f\n  Config:  %s\n\n' \
      "$SERVICE_NAME" "$SERVICE_NAME" "$ENV_FILE" >&2
  else
    warn "Service $SERVICE_NAME failed to start. Recent logs:"
    $SUDO journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2 || true
    exit 1
  fi
else
  printf '\nRun the agent with:\n\n' >&2
  printf '  HUB_URL=%q AGENT_TOKEN=%q INTERVAL=%q DOCKER=%q %q\n\n' \
    "$HUB_URL" "$AGENT_TOKEN" "$INTERVAL" "$DOCKER" "$TARGET_BIN" >&2
fi
