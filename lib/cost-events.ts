/**
 * Cost event recording + aggregation (Item 9).
 *
 * One row per spar model turn (well, per stream — see upsert note). The
 * `cost_events` table is created in lib/db.ts migrate(). We record the
 * token usage the spar route already surfaces via its `emitUsage` hook,
 * priced through lib/cost-pricing.ts.
 *
 * SCOPE / HONESTY NOTE: the usage we can capture today is the sparring
 * partner's OWN model spend, attributable to a user. Work the assistant
 * dispatches into a project's Claude Code terminal runs as a SEPARATE
 * CLI process whose token usage we do not capture — so `project_id` is
 * nullable and currently only set when a caller can attribute a turn to
 * a project. The schema is ready for real per-project attribution later;
 * the aggregation groups by project_id (NULL bucketed as "(spar)").
 *
 * Also: on the subscription CLI path (no AMASO_SPAR_ANTHROPIC_KEY) the
 * CLI often reports zero token usage, so cost rows there will be $0. The
 * numbers get real when the SDK path is active. recordCostEvent never
 * throws — cost tracking must never break a chat turn.
 */

import { getDb } from "./db";
import { estimateCostUsd, type UsageCounts } from "./cost-pricing";

export interface RecordCostInput {
  /** Stable per-request id so repeated cumulative emits upsert one row. */
  streamId: string;
  userId: number;
  /** Project this turn is attributable to, or null for plain spar chat. */
  projectId?: string | null;
  model: string;
  tier?: string | null;
  usage: UsageCounts;
}

/**
 * Upsert a cost event keyed by stream_id. The spar route calls emitUsage
 * repeatedly with CUMULATIVE totals as the turn streams; upserting on
 * stream_id means we keep exactly one row per turn holding the final
 * cumulative figures instead of N partial rows. Idempotent + safe.
 */
export function recordCostEvent(input: RecordCostInput): void {
  try {
    const u = input.usage;
    const costUsd = estimateCostUsd(input.model, u);
    getDb()
      .prepare(
        `INSERT INTO cost_events
           (stream_id, user_id, project_id, model, tier,
            input_tokens, output_tokens, cache_creation_tokens,
            cache_read_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stream_id) DO UPDATE SET
           input_tokens          = excluded.input_tokens,
           output_tokens         = excluded.output_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens,
           cache_read_tokens     = excluded.cache_read_tokens,
           cost_usd              = excluded.cost_usd,
           model                 = excluded.model,
           tier                  = excluded.tier`,
      )
      .run(
        input.streamId,
        input.userId,
        input.projectId ?? null,
        input.model,
        input.tier ?? null,
        Math.max(0, u.inputTokens || 0),
        Math.max(0, u.outputTokens || 0),
        Math.max(0, u.cacheCreationTokens || 0),
        Math.max(0, u.cacheReadTokens || 0),
        costUsd,
        Date.now(),
      );
  } catch (err) {
    console.warn(
      "[cost-events] failed to record cost event:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface CostBucket {
  /** Project id, or "(spar)" for unattributed spar-chat spend. */
  projectId: string;
  /** ISO date (YYYY-MM-DD) for daily buckets, or YYYY-MM for monthly. */
  period: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
}

interface RawBucket {
  project_id: string | null;
  period: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  turns: number;
}

/**
 * Aggregate cost events grouped by (project, period). granularity "day"
 * → YYYY-MM-DD, "month" → YYYY-MM. `sinceMs` bounds the window (default
 * 90 days). SQLite localtime so the buckets match the operator's day.
 */
export function aggregateCosts(
  granularity: "day" | "month" = "day",
  sinceMs: number = Date.now() - 90 * 24 * 60 * 60 * 1000,
): CostBucket[] {
  const fmt = granularity === "month" ? "%Y-%m" : "%Y-%m-%d";
  const rows = getDb()
    .prepare(
      `SELECT
         project_id AS project_id,
         strftime('${fmt}', created_at / 1000, 'unixepoch', 'localtime') AS period,
         SUM(input_tokens)          AS input_tokens,
         SUM(output_tokens)         AS output_tokens,
         SUM(cache_creation_tokens) AS cache_creation_tokens,
         SUM(cache_read_tokens)     AS cache_read_tokens,
         SUM(cost_usd)              AS cost_usd,
         COUNT(*)                   AS turns
       FROM cost_events
       WHERE created_at >= ?
       GROUP BY project_id, period
       ORDER BY period DESC, cost_usd DESC`,
    )
    .all(sinceMs) as RawBucket[];
  return rows.map((r) => ({
    projectId: r.project_id ?? "(spar)",
    period: r.period,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    costUsd: Math.round((r.cost_usd ?? 0) * 1e6) / 1e6,
    turns: r.turns,
  }));
}
