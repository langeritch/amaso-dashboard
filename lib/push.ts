// Web Push for the Amaso Dashboard.
//
// Browsers hand us an opaque `endpoint` (vendor-specific push service URL)
// plus an ECDH keypair per subscription. We store those per user and POST
// via the VAPID-authenticated web-push protocol when something interesting
// happens (new chat message, new remark targeting you).
//
// Config comes from env:
//   AMASO_VAPID_PUBLIC   — ECDSA public key, also exposed to the client
//   AMASO_VAPID_PRIVATE  — keep secret; server-only
//   AMASO_VAPID_SUBJECT  — mailto: or https: contact per VAPID spec
//
// If the keys are missing we silently no-op — the dashboard still works,
// just without push delivery, and the "Enable notifications" UI hides.

import webpush from "web-push";
import { getDb } from "./db";

const VAPID_PUBLIC = process.env.AMASO_VAPID_PUBLIC ?? "";
const VAPID_PRIVATE = process.env.AMASO_VAPID_PRIVATE ?? "";
const VAPID_SUBJECT = process.env.AMASO_VAPID_SUBJECT ?? "mailto:admin@amaso.nl";

export function pushEnabled(): boolean {
  return Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
}

export function getPublicVapidKey(): string {
  return VAPID_PUBLIC;
}

let configured = false;
function configure() {
  if (configured || !pushEnabled()) return;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function saveSubscription(
  userId: number,
  sub: BrowserSubscription,
  userAgent: string | null,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id    = excluded.user_id,
       p256dh     = excluded.p256dh,
       auth       = excluded.auth,
       user_agent = excluded.user_agent`,
  ).run(
    userId,
    sub.endpoint,
    sub.keys.p256dh,
    sub.keys.auth,
    userAgent,
    Date.now(),
  );
}

export function deleteSubscription(endpoint: string): void {
  getDb()
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .run(endpoint);
}

interface Subscription {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function subscriptionsForUsers(userIds: number[]): Subscription[] {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT id, user_id, endpoint, p256dh, auth
         FROM push_subscriptions
        WHERE user_id IN (${placeholders})`,
    )
    .all(...userIds) as Subscription[];
}

export interface PushPayload {
  title: string;
  body: string;
  /** Deep-link path inside the app. Clicked notification focuses/opens it. */
  url?: string;
  /** Groups same-topic notifications — newer replaces older in the shade. */
  tag?: string;
  /** Free-form metadata echoed back via notificationclick. */
  data?: Record<string, unknown>;
}

/** Send a push to every active subscription owned by these users. Failures
 *  are logged + stale 404/410 endpoints are pruned. Fire-and-forget: the
 *  caller awaits nothing. */
export async function pushToUsers(
  userIds: number[],
  payload: PushPayload,
): Promise<void> {
  if (!pushEnabled()) return;
  configure();

  const subs = subscriptionsForUsers(userIds);
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        },
        body,
        { TTL: 60 * 60 * 24 }, // one day — after that the notification is stale
      ),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") continue;
    const err = r.reason as { statusCode?: number } | undefined;
    const code = err?.statusCode;
    if (code === 404 || code === 410) {
      // Browser has unsubscribed or the endpoint has expired. Drop it so we
      // don't keep retrying every message.
      deleteSubscription(subs[i].endpoint);
    } else {
      console.warn("[push] send failed", {
        endpoint: subs[i].endpoint.slice(0, 80),
        code,
      });
    }
  }
}
