# Spar model router (Layer 2)

Pure heuristic router for spar turns. Lives in `lib/spar-model-router.ts`.

## Goal

Stop paying Opus rates on every spar reply. Default to Haiku for short
conversational turns; reserve Opus for tool use, brain writes, real
decisions, and explicit "think hard". Sonnet sits in the middle for one
narrow case (auto-report turns).

## Rules (first match wins)

1. **Caller override**: `body.model` on the request wins everything.
   Lets the mobile client pin a specific model when the user toggles.
2. **Explicit "quick" / "quick:" prefix**: force Haiku. Checked before
   hard floors so the user can opt out of an Opus reply when they
   explicitly want fast and cheap.
3. **Hard floors (Opus, never downgrade)**:
   - dispatch intent (`dispatch`, `kick off`, `send to project`, ...)
   - brain write intent (`write/update/edit ... brain|memory|profile|graph|daily log`)
   - explicit `brain file` / `daily log` / `knowledge graph` phrases
   - graph / profile write intent (`update my profile`, `remember that`,
     `put this on my profile`, `add to the graph`)
   - decision intent (`decided`, `let's go with`, `should we`,
     `what should`, `new goal`, `kill the project`, ...)
   - planning intent (`plan`, `architecture`, `roadmap`, `strategy`,
     `tradeoff`, ...)
   - explicit `think hard` anywhere in the message
4. **Auto-report turns** (`check the output of terminal for ...`):
   floored at Sonnet.
5. **Length-based default** on the latest user message body:
   - `< 80 chars` → Haiku
   - otherwise → Opus

## Audit log

`logs/spar-router.jsonl`, one decision per line. Fields:

```
ts, source, userId, conversationId, autopilot, requestedModel,
chosenModel, tier, rule, reason, messageLength, messagePreview
```

`source` is one of `api/spar`, `companion-relay`, `telegram-respond`,
`mobile-chat`. Use `tail -f logs/spar-router.jsonl | jq` for a live
view; group by `tier` to estimate savings.

A console line (`[spar-router] ...`) is emitted on every decision so
`app.log` already shows routing without opening the jsonl.

## Per-turn token badge

The `usage` event on the spar NDJSON stream now carries the chosen
model id alongside the token counts. The chat surface badge shows both
input/output/cache numbers and the model that handled the turn.

## Tuning knobs

All in one place at the top of `lib/spar-model-router.ts`:

- `ROUTER_MODELS` — concrete model IDs. Override per-env with
  `AMASO_SPAR_MODEL_OPUS`, `AMASO_SPAR_MODEL_SONNET`,
  `AMASO_SPAR_MODEL_HAIKU`.
- `HARD_FLOOR_PATTERNS` — keyword regexes that force Opus.
- `QUICK_PREFIX_RE`, `THINK_HARD_RE` — explicit overrides.
- `HAIKU_MAX_CHARS` — length threshold for the default.

## Layer 1 interaction

Layer 1 (prompt caching in `lib/spar-sdk.ts`) is independent. The
cache breakpoints are on the static prefix (system prompt + brain +
tool schemas), so cache hits keep working across model swaps within
the same model family. Note: cache is per-model, so a Sonnet turn
followed by an Opus turn each pay their own cache_creation.

## Not wired

`lib/task-agent.ts` still pins `SPAR_MODEL` directly. Task-agent runs
persistent dispatched work, not conversational replies, so the
heuristics here don't fit. If we want to route task-agent later it
should get its own rules.
