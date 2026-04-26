import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isSuperUser } from "@/lib/heartbeat";
import {
  CONFIDENCE_LEVELS,
  ENTITY_TYPES,
  deleteEntity,
  deleteRelationship,
  updateEntity,
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
 * PATCH — update an entity by id. The body's `kind` selects entity
 * vs relationship targeting, defaulting to entity (the common case).
 * Relationships are append-only edges in the spec, so PATCH only
 * accepts entity targets right now; if a relationship needs to
 * change, delete + re-add via POST.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentUser();
  if (!me) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;

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

  const patch: Parameters<typeof updateEntity>[2] = {};
  if (typeof body?.name === "string") patch.name = body.name;
  if (typeof body?.type === "string") {
    if (!ENTITY_TYPES.includes(body.type as EntityType)) {
      return new Response("invalid entity type", { status: 400 });
    }
    patch.type = body.type as EntityType;
  }
  if (body?.properties && typeof body.properties === "object") {
    patch.properties = body.properties as Record<string, unknown>;
  }
  if (typeof body?.confidence === "string") {
    if (!CONFIDENCE_LEVELS.includes(body.confidence as Confidence)) {
      return new Response("invalid confidence", { status: 400 });
    }
    patch.confidence = body.confidence as Confidence;
  }
  if (typeof body?.sourceExcerpt === "string")
    patch.sourceExcerpt = body.sourceExcerpt;
  if (body?.sourceExcerpt === null) patch.sourceExcerpt = null;
  if (body?.replaceProperties === true) patch.replaceProperties = true;

  const updated = await updateEntity(ownerId, id, patch);
  if (!updated) return new Response("not found", { status: 404 });
  return Response.json({ userId: ownerId, entity: updated });
}

/**
 * DELETE — removes an entity OR a relationship by id. We try
 * entities first (most common); falls through to relationship
 * deletion if no entity matched. The cascade rule lives in
 * deleteEntity (relationships involving the deleted node are also
 * removed).
 *
 * Query params:
 *   ?user=<id>   super-user only
 *   ?kind=relationship  skip the entity-first probe
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const me = await getCurrentUser();
  if (!me) return new Response("unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const ownerId = parseUserId(url.searchParams.get("user"), me.id);
  if (ownerId !== me.id && !isSuperUser(me)) {
    return new Response("forbidden", { status: 403 });
  }
  const kind = url.searchParams.get("kind");
  if (kind === "relationship") {
    const ok = await deleteRelationship(ownerId, id);
    if (!ok) return new Response("not found", { status: 404 });
    return new Response(null, { status: 204 });
  }
  const okEntity = await deleteEntity(ownerId, id);
  if (okEntity) return new Response(null, { status: 204 });
  // Caller may have hit the wrong kind without the query param —
  // try the relationship side before 404'ing.
  const okRel = await deleteRelationship(ownerId, id);
  if (okRel) return new Response(null, { status: 204 });
  return new Response("not found", { status: 404 });
}
