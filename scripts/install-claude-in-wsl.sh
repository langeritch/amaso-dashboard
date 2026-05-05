#!/bin/bash
# Install Claude Code CLI inside WSL2 Ubuntu so it can run under tmux for the
# /spar2 dashboard page. Idempotent — re-running upgrades to latest.
set -e

echo "=== node + npm (needed for @anthropic-ai/claude-code) ==="
if ! command -v node >/dev/null 2>&1; then
  echo "  installing node 20 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node -v
npm -v

echo
echo "=== install/upgrade @anthropic-ai/claude-code globally ==="
npm install -g @anthropic-ai/claude-code

echo
echo "=== verify ==="
which claude
claude --version 2>&1 | head -3

echo
echo "=== installer DONE ==="
echo "Next: run \`claude\` interactively (in WSL) to authenticate via browser OAuth."
