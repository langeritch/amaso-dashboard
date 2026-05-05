#!/bin/bash
# Re-check Hermes auth state + try every plausible permutation against
# Anthropic's API to pin down what the actual rejection is.
set -e

echo "=== current credentials ==="
hermes auth list 2>&1 | head -30

echo
echo "=== auth.json — what's the active credential right now? ==="
python3 <<'PY'
import json
with open("/root/.hermes/auth.json") as f:
    d = json.load(f)
pool = d.get("credential_pool", {}).get("anthropic", [])
print(f"  total anthropic credentials: {len(pool)}")
for i, c in enumerate(pool):
    src = c.get("source", "?")
    typ = c.get("auth_type", "?")
    tok = c.get("access_token", "")
    apik = c.get("api_key", "")
    val = tok or apik
    print(f"  [{i}] source={src} type={typ} token={val[:14]}…{val[-8:] if len(val)>22 else ''} (len {len(val)})")
PY

echo
echo "=== test API directly with the FIRST credential (api_key path) ==="
python3 <<'PY' > /tmp/anthropic_test.py
import json, sys
with open("/root/.hermes/auth.json") as f:
    d = json.load(f)
pool = d.get("credential_pool", {}).get("anthropic", [])
if not pool:
    print("no creds")
    sys.exit(0)
c = pool[0]
typ = c.get("auth_type", "?")
tok = c.get("access_token") or c.get("api_key") or ""
print(f"using cred [0]: type={typ}, source={c.get('source')}, len={len(tok)}")
print(f"token starts: {tok[:14]}")
print(f"token ends:   {tok[-8:]}")
# print the token to a file for the curl test
with open("/tmp/the_token", "w") as f:
    f.write(tok)
PY
python3 /tmp/anthropic_test.py
TOKEN="$(cat /tmp/the_token 2>/dev/null)"

echo
echo "=== try /v1/messages with x-api-key header (api-key auth path) ==="
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-5","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}' \
  | head -30

echo
echo "=== try /v1/messages with Authorization: Bearer (oauth path) ==="
curl -sS https://api.anthropic.com/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-5","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}' \
  | head -30

echo
echo "=== /v1/models with x-api-key (lists models the key can use) ==="
curl -sS https://api.anthropic.com/v1/models \
  -H "x-api-key: $TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  | head -40
