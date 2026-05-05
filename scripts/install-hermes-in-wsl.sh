#!/bin/bash
# Run inside WSL2 Ubuntu (as root). Installs tmux + curl + Hermes Agent.
# Idempotent: re-running is safe.
set -e

echo "=== apt: tmux, curl, git, build-essential ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tmux curl ca-certificates git build-essential

echo
echo "=== Hermes installer ==="
if command -v hermes >/dev/null 2>&1; then
  echo "hermes already on PATH at: $(command -v hermes) — skipping installer"
else
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o /tmp/hermes-install.sh
  chmod +x /tmp/hermes-install.sh
  bash /tmp/hermes-install.sh
fi

echo
echo "=== verify ==="
if [ -x "$HOME/.local/bin/hermes" ]; then
  echo "found: $HOME/.local/bin/hermes"
  "$HOME/.local/bin/hermes" --version 2>&1 || true
elif command -v hermes >/dev/null 2>&1; then
  echo "found on PATH: $(command -v hermes)"
  hermes --version 2>&1 || true
else
  echo "WARNING: hermes binary not found post-install"
  ls -la "$HOME/.local/bin" 2>/dev/null || true
fi

echo
echo "=== installer DONE ==="
