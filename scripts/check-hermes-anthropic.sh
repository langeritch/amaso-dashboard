#!/bin/bash
# Diagnose Hermes ↔ Anthropic OAuth: what models does the stored token
# actually have access to, and is the configured model in that list.
set -e

echo "=== auth files ==="
find /root/.hermes -type f \( -name '*.json' -o -name '*.toml' \) 2>/dev/null \
  | head -20

echo
echo "=== hermes auth list (anthropic) ==="
hermes auth list 2>&1 | head -20

echo
echo "=== read the active anthropic credential (token redacted) ==="
python3 - <<'PY'
import json, glob, os, sys
candidates = []
for p in glob.glob("/root/.hermes/**/*.json", recursive=True):
    try:
        d = json.load(open(p))
        if isinstance(d, dict) and any("anthropic" in k.lower() or "anthropic" in str(v).lower() for k,v in d.items() if isinstance(v,(str,int))):
            candidates.append((p, d))
        elif "anthropic" in p.lower():
            candidates.append((p, d))
    except Exception:
        pass

for p, d in candidates[:5]:
    print(f"file: {p}")
    if isinstance(d, dict):
        for k, v in d.items():
            if isinstance(v, str) and len(v) > 30:
                print(f"  {k}: {v[:10]}…{v[-6:]}  (len {len(v)})")
            else:
                print(f"  {k}: {v}")
    print()
PY

echo "=== try Anthropic models endpoint with the stored token ==="
TOKEN="$(python3 -c '
import json, glob
for p in glob.glob("/root/.hermes/**/*.json", recursive=True):
    try:
        d = json.load(open(p))
        if isinstance(d, dict):
            tok = d.get("access_token") or d.get("token") or d.get("apiKey")
            if tok and len(tok) > 30 and "anthropic" in p.lower():
                print(tok)
                break
    except Exception:
        pass
')"
if [ -n "$TOKEN" ]; then
  echo "token len: ${#TOKEN}"
  echo "--- /v1/models ---"
  curl -sS https://api.anthropic.com/v1/models \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: oauth-2025-04-20" \
    | python3 -m json.tool 2>&1 | head -80
else
  echo "no token found"
fi
