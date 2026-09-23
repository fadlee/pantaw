#!/usr/bin/env bash
set -e

# Pantaw Agent One-Line Installer
# Repository: https://github.com/fadlee/pantaw

REPO="fadlee/pantaw"
VERSION="${VERSION:-latest}"
HUB_URL="${HUB_URL:-}"
AGENT_TOKEN="${AGENT_TOKEN:-}"
INTERVAL="${INTERVAL:-30}"
DOCKER="${DOCKER:-false}"
INSTALL_DIR="/usr/local/bin"

# Parse CLI flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--hub-url)
      HUB_URL="$2"
      shift 2
      ;;
    -t|--token)
      AGENT_TOKEN="$2"
      shift 2
      ;;
    -v|--version)
      VERSION="$2"
      shift 2
      ;;
    -i|--interval)
      INTERVAL="$2"
      shift 2
      ;;
    --docker)
      DOCKER="true"
      shift
      ;;
    -h|--help)
      echo "Usage: curl -sL https://raw.githubusercontent.com/$REPO/main/install-agent.sh | bash -s -- [options]"
      echo ""
      echo "Options:"
      echo "  -u, --hub-url <url>      Pantaw Hub URL (required)"
      echo "  -t, --token <token>      Pantaw Agent Token (required)"
      echo "  -i, --interval <sec>     Reporting interval in seconds (default: 30)"
      echo "  -v, --version <version>  Version to install (default: latest)"
      echo "      --docker             Enable Docker container monitoring"
      echo "  -h, --help               Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ -z "$HUB_URL" ] || [ -z "$AGENT_TOKEN" ]; then
  echo "Error: HUB_URL and AGENT_TOKEN are required."
  echo "Usage: curl -sL https://raw.githubusercontent.com/$REPO/main/install-agent.sh | bash -s -- -u <HUB_URL> -t <AGENT_TOKEN>"
  exit 1
fi

# Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    ARCH="amd64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

if [ "$OS" != "linux" ] && [ "$OS" != "darwin" ]; then
  echo "Unsupported OS: $OS (only Linux and macOS supported)"
  exit 1
fi

# Resolve version
if [ "$VERSION" = "latest" ]; then
  echo "==> Resolving latest version for $REPO..."
  TAG=$(curl -sL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
  if [ -z "$TAG" ]; then
    echo "Warning: could not resolve latest release tag from GitHub API, falling back to main build"
    TAG="latest"
  fi
else
  TAG="$VERSION"
fi

BINARY_NAME="pantaw-agent-${OS}-${ARCH}"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/${TAG}/${BINARY_NAME}"

echo "==> Downloading Pantaw Agent ($TAG for ${OS}-${ARCH})..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if ! curl -sL --fail "$DOWNLOAD_URL" -o "$TMP_DIR/pantaw-agent"; then
  echo "Failed to download binary from $DOWNLOAD_URL"
  echo "Please check available releases at https://github.com/$REPO/releases"
  exit 1
fi

chmod +x "$TMP_DIR/pantaw-agent"

# Install binary
IS_ROOT=false
if [ "$(id -u)" -eq 0 ]; then
  IS_ROOT=true
fi

if [ "$IS_ROOT" = true ]; then
  mkdir -p "$INSTALL_DIR"
  mv "$TMP_DIR/pantaw-agent" "$INSTALL_DIR/pantaw-agent"
  TARGET_BIN="$INSTALL_DIR/pantaw-agent"
else
  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$INSTALL_DIR"
    sudo mv "$TMP_DIR/pantaw-agent" "$INSTALL_DIR/pantaw-agent"
    TARGET_BIN="$INSTALL_DIR/pantaw-agent"
    IS_ROOT=true
  else
    mkdir -p "$HOME/.local/bin"
    mv "$TMP_DIR/pantaw-agent" "$HOME/.local/bin/pantaw-agent"
    TARGET_BIN="$HOME/.local/bin/pantaw-agent"
  fi
fi

echo "==> Binary installed at $TARGET_BIN"

# Setup systemd service if available on Linux
if [ "$OS" = "linux" ] && [ "$IS_ROOT" = true ] && command -v systemctl >/dev/null 2>&1; then
  echo "==> Configuring systemd service..."
  
  mkdir -p /etc/pantaw
  cat > /etc/pantaw/agent.env <<EOF
HUB_URL=${HUB_URL}
AGENT_TOKEN=${AGENT_TOKEN}
INTERVAL=${INTERVAL}
DOCKER=${DOCKER}
LOG_LEVEL=info
EOF
  chmod 600 /etc/pantaw/agent.env

  cat > /etc/systemd/system/pantaw-agent.service <<EOF
[Unit]
Description=Pantaw Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/pantaw/agent.env
ExecStart=${TARGET_BIN}
Restart=always
RestartSec=5s

# Security sandboxing
ProtectSystem=full
ProtectHome=read-only
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now pantaw-agent
  echo "==> Pantaw Agent service started and enabled on boot!"
  echo "==> Check status with: systemctl status pantaw-agent"
else
  echo ""
  echo "==> Pantaw Agent is ready to run!"
  echo "Start with:"
  echo "  export HUB_URL=\"$HUB_URL\""
  echo "  export AGENT_TOKEN=\"$AGENT_TOKEN\""
  echo "  $TARGET_BIN"
fi
