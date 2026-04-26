import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isSuperUser } from "@/lib/heartbeat";
import {
  ENTITY_TYPES,
  CONFIDENCE_LEVELS,
  queryGraph,
  readGraph,
  upsertEntity,
  upsertRelationship,
  type Confidence,
  type EntityType,
} from "@/lib/knowledge-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseUserId(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * GET — full graph or a filtered/ranked subset.
 *
 * Query params:
 *   ?user=<id>            super-user only; defaults to caller
 *   ?type=person,tool     filter to these entity types (comma-list)
 *   ?q=morning            free-text search across names + properties
 *   ?limit=80             cap on returned entities (default 80)
 *   ?raw=1                bypass ranking, return the whole graph as-is
 *                         (useful for the /memory UI which paginates
 *                         locally)
 */
export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const ownerId = parseUserId(url.searchParams.get("user"), me.id);
  if (ownerId !== me.id && !isSuperUser(me)) {
    return new Response("forbidden", { status: 403 });
  }

  const raw = url.searchParams.get("raw") === "1";
  if (raw) {
    const graph = await readGraph(ownerId);
    return Response.json({
      userId: ownerId,
      entityCount: graph.entities.length,
      relationshipCount: graph.relationships.length,
      entities: graph.entities,
      relationships: graph.relationships,
    });
  }

  const typesParam = url.searchParams.get("type");
  const types = typesParam
    ? typesParam
        .split(",")
        .map((t) => t.trim())
        .filter((t): t is EntityType =>
          ENTITY_TYPES.includes(t as EntityType),
        )
    : undefined;
  const q = url.searchParams.get("q") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const limit =
    limitParam && Number.isFinite(Number(limitParam))
      ? Math.max(1, Math.min(500, Number(limitParam)))
      : undefined;

  const result = await queryGraph(ownerId, { types, q, limit });
  return Response.json({
    userId: ownerId,
    entityCount: result.entities.length,
    relationshipCount: result.relationships.length,
    entities: result.entities,
    relationships: result.relationships,
  });
}

/**
 * POST — manual add. Two shapes:
 *   { kind: "entity", type, name, properties?, confidence?, sourceExcerpt? }
 *   { kind: "relationship", fromId, toId, type, properties?, confidence? }
 *
 * Source defaults to "explicit" because anything entered by hand IS
 * an explicit user statement — the manual UI is the user-of-record.
 */
export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return new Response("unauthorized", { status: 401 });
  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const ownerId = parseUserId(
    body?.userId != null ? String(body.userId) : null,
    me.id,
  );
  if (ownerId !== me.id && !isSuperUser(me)) {
    return new Response("forbidden", { status: 403 });
  }

  const kind = typeof body?.kind === "string" ? body.kind : "entity";
  if (kind === "relationship") {
    const fromId = typeof body?.fromId === "string" ? body.fromId : "";
    const toId = typeof body?.toId === "string" ? body.toId : "";
    const type = typeof body?.type === "string" ? body.type.trim() : "";
    if (!fromId || !toId || !type) {
      return new Response(
        "fromId, toId and type are required",
        { status: 400 },
      );
    }
    const confidence = parseConfidence(body?.confidence) ?? "explicit";
    const properties =
      body?.properties && typeof body.properties === "object"
        ? (body.properties as Record<string, unknown>)
        : undefined;
    const rel = await upsertRelationship(ownerId, {
      fromId,
      toId,
      type,
      properties,
      confidence,
    });
    if (!rel) {
      return new Response("from/to entity not found", { status: 400 });
    }
    return Response.json({ userId: ownerId, relationship: rel });
  }

  // entity (default)
  const type = typeof body?.type === "string" ? body.type : "";
  if (!ENTITY_TYPES.includes(type as EntityType)) {
    return new Response("invalid entity type", { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return new Response("name is required", { status: 400 });
  const properties =
    body?.properties && typeof body.properties === "object"
      ? (body.properties as Record<string, unknown>)
      : undefined;
  const confidence = parseConfidence(body?.confidence) ?? "explicit";
  const sourceExcerpt =
    typeof body?.sourceExcerpt === "string" ? body.sourceExcerpt : null;
  const replaceProperties = body?.replaceProperties === true;

  const entity = await upsertEntity(ownerId, {
    type: type as EntityType,
    name,
    properties,
    confidence,
    sourceExcerpt,
    replaceProperties,
  });
  return Response.json({ userId: ownerId, entity });
}

function parseConfidence(raw: unknown): Confidence | null {
  if (typeof raw !== "string") return null;
  return CONFIDENCE_LEVELS.includes(raw as Confidence)
    ? (raw as Confidence)
    : null;
}
