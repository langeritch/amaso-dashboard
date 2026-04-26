// Canonical wire format between the Chrome extension and the dashboard
// API. The extension is plain JS (no build step) so it can't import
// these types directly — keep these definitions and the field names in
// extension/content.js in sync by hand. Adding fields is safe; renames
// or removals require touching both sides.

export type RecordingEventType =
  | "click"
  | "input"
  | "submit"
  | "navigation"
  | "keydown";

export interface RecordingEventTarget {
  selector: string;
  text: string | null;
  tagName: string;
  role: string | null;
  // Bounding box at capture time. Useful for replay debugging when the
  // selector resolves to something different on rehydration.
  rect: { x: number; y: number; width: number; height: number } | null;
}

export interface RecordingEvent {
  // Monotonic per-session id assigned by the extension so the API can
  // reject duplicates from a flush retry.
  clientId: string;
  type: RecordingEventType;
  // ms since epoch on the recording client.
  timestamp: number;
  url: string;
  // Page title at the time of capture, for human-friendly display.
  title: string | null;
  // Present for click/input/submit. Null for navigation/keydown.
  target: RecordingEventTarget | null;
  // Text typed (input) or the key pressed (keydown). For inputs we
  // capture the final value on blur, never per-keystroke; password
  // fields are skipped entirely.
  value: string | null;
  // The extension's confidence that it knows what the user did. When
  // false, the dashboard surfaces this event for human clarification.
  needs_clarification: boolean;
  clarification_reason: string | null;
}

export type RecordingSessionStatus = "active" | "ended";

export type RecordingAnalysisStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface RecordingSession {
  id: string;
  userId: number;
  startedAt: number;
  endedAt: number | null;
  status: RecordingSessionStatus;
  // User-given title set from the end-of-session modal. NULL until the
  // user saves with a name, and allowed to stay NULL if they save
  // untitled.
  name: string | null;
  // NULL when the user has never requested AI analysis for this session.
  analysisStatus: RecordingAnalysisStatus | null;
  // Populated once a worker fills it in; free-form text/JSON.
  analysisResult: string | null;
  // Convenience counts for list UIs.
  eventCount: number;
  needsClarificationCount: number;
  // Automation that launched this recording, or NULL for ad-hoc sessions
  // started without going through the launcher.
  automationId: number | null;
}

// Stored event row, as returned from GET /api/recording/sessions/[id].
// Includes the user's after-the-fact clarification text (null until
// they fill it in via the review UI).
export interface StoredRecordingEvent extends RecordingEvent {
  id: number;
  sessionId: string;
  clarification: string | null;
}

// POST /api/recording/sessions/[id]/events request body.
export interface IngestEventsRequest {
  events: RecordingEvent[];
}

// PATCH /api/recording/sessions/[id]/events/[eventId] request body.
export interface ClarifyEventRequest {
  clarification: string;
}
