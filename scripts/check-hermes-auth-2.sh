#!/bin/bash
# Inspect /root/.hermes/auth.json + try a minimal Anthropic API call.
set -e

echo "=== auth.json structure ==="
python3 <<'PY'
import json
with open("/root/.hermes/auth.json") as f:
    d = json.load(f)
def red(v):
    if isinstance(v, str) and len(v) > 30:
        return f"{v[:14]}…{v[-8:]}  (len {len(v)})"
    return v
def walk(d, depth=0):
    pad = "  " * depth
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, (dict, list)):
                print(f"{pad}{k}:")
                walk(v, depth + 1)
            else:
                print(f"{pad}{k}: {red(v)}")
    elif isinstance(d, list):
        for i, v in enumerate(d):
            print(f"{pad}[{i}]:")
            walk(v, depth + 1)
walk(d)
PY

echo
echo "=== extract OAuth access_token + try /v1/models ==="
python3 <<'PY' > /tmp/hermes_token
import json
with open("/root/.hermes/auth.json") as f:
    d = json.load(f)
# Find any string field that looks like a JWT or sk-ant-* token.
def find(d, found):
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, str) and (v.startswith("sk-ant-") or v.startswith("eyJ") or "oauth" in k.lower() or k.lower() in ("access_token","apikey","api_key","token","key","credential")):
                found.append((k, v))
            else:
                find(v, found)
    elif isinstance(d, list):
        for v in d:
            find(v, found)
candidates = []
find(d, candidates)
# Print to stderr what we found
import sys
for k, v in candidates:
    print(f"  {k}: {v[:14]}…{v[-8:]} (len {len(v)})", file=sys.stderr)
# Pick the most promising
chosen = None
for k, v in candidates:
    if v.startswith("sk-ant-"):
        chosen = v; break
if not chosen:
    for k, v in candidates:
        if v.startswith("eyJ"):
            chosen = v; break
if chosen:
    print(chosen)
PY
TOKEN="$(cat /tmp/hermes_token 2>/dev/null)"
echo "  token chosen len: ${#TOKEN}"

if [ -n "$TOKEN" ]; then
  echo
  echo "=== POST /v1/messages with claude-opus-4-6 (the failing call) ==="
  curl -sS https://api.anthropic.com/v1/messages \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-opus-4-6","max_tokens":50,"messages":[{"role":"user","content":"say hi in 3 words"}]}' \
    | head -50

  echo
  echo "=== POST /v1/messages with claude-opus-4-5 (known-stable older alias) ==="
  curl -sS https://api.anthropic.com/v1/messages \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-opus-4-5","max_tokens":50,"messages":[{"role":"user","content":"say hi in 3 words"}]}' \
    | head -50

  echo
  echo "=== POST /v1/messages with claude-sonnet-4-5 ==="
  curl -sS https://api.anthropic.com/v1/messages \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-sonnet-4-5","max_tokens":50,"messages":[{"role":"user","content":"say hi in 3 words"}]}' \
    | head -50
else
  echo "no usable token extracted from auth.json"
fi
