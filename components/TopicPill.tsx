"use client";

/**
 * Topic pill — small dismissable chip that signals an active topic
 * scope for the next spar turn. Used by both the desktop SparFullView
 * composer and the mobile ChatScreen composer so the two surfaces
 * stay visually consistent.
 *
 * Visual weight is intentionally subtle: a thin outlined chip with
 * orange accent text + an × button. The pill never grabs more than
 * one row of vertical space above the composer.
 *
 * State of activeTopic lives on the consumer (SparContext for the
 * dashboard; MobileApp state for the PWA). This component is purely
 * presentational — it takes the topic + a dismiss callback and
 * renders.
 */

export interface ActiveTopic {
  /** topics.id from the DB. The spar API uses this to fetch the
   *  topic's summary + tagged messages for the system prompt. */
  id: number;
  /** Slug for deep-linking + as a stable label in logs. */
  slug: string;
  /** Human-readable title shown on the pill. */
  title: string;
}

export interface TopicPillProps {
  topic: ActiveTopic;
  onDismiss: () => void;
  /** "compact" is the default — used above composers. "inline"
   *  bumps padding for use in row-level UIs (e.g. an admin table). */
  variant?: "compact" | "inline";
  /** Optional click handler for the pill body. Hooks to the topic's
   *  history view; the × stays separately clickable. */
  onClick?: () => void;
}

const COMPACT_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 4px 3px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontFamily: "var(--font-sans, system-ui)",
  background: "rgba(249, 115, 22, 0.10)",
  border: "1px solid rgba(249, 115, 22, 0.45)",
  color: "#f6f6f4",
  lineHeight: 1.3,
  maxWidth: "100%",
  minWidth: 0,
};

const INLINE_STYLE: React.CSSProperties = {
  ...COMPACT_STYLE,
  padding: "5px 6px 5px 12px",
  fontSize: 12,
};

const DISMISS_STYLE: React.CSSProperties = {
  width: 18,
  height: 18,
  padding: 0,
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "rgba(246,246,244,0.85)",
  borderRadius: 6,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

export function TopicPill({ topic, onDismiss, variant = "compact", onClick }: TopicPillProps) {
  const wrapStyle = variant === "inline" ? INLINE_STYLE : COMPACT_STYLE;
  return (
    <span style={wrapStyle} data-topic-pill={topic.slug} role="status" aria-live="polite">
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "#f97316",
          flexShrink: 0,
        }}
      />
      <button
        type="button"
        onClick={onClick}
        title={onClick ? `Open ${topic.title}` : topic.title}
        style={{
          flex: 1,
          minWidth: 0,
          padding: 0,
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: onClick ? "pointer" : "default",
          font: "inherit",
          textAlign: "left",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        topic: <strong style={{ fontWeight: 600 }}>{topic.title}</strong>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        aria-label={`Dismiss topic ${topic.title}`}
        title="Dismiss topic scope"
        style={DISMISS_STYLE}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </svg>
      </button>
    </span>
  );
}
