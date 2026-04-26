// Single source of truth for the demo walkthrough.
//
// The tour is a flat list of steps keyed by `atMs` (ms since the tour
// started). The runner (components/demo/DemoTour.tsx) ticks through the
// list in order and applies each step's effects: updates the caption,
// glides the fake cursor, and/or fires a one-shot action (type into an
// input, pulse a click, navigate to a route).
//
// To restructure the tour: reorder steps, tweak `atMs`, or add new ones.
// Nothing else in the demo system depends on the contents.
//
// Coordinate systems:
// - `cursor: { x, y }` — percentages of the viewport (0–100). Good for
//   rough placements that don't need to hit a specific element.
// - `cursor: { selector }` — the runner finds the element via
//   querySelector and glides the cursor to its center. Preferred
//   whenever the cursor needs to "land on" a clickable control.

export type CursorTarget =
  | { x: number; y: number }
  | { selector: string; offset?: { dx: number; dy: number } };

export type DemoAction =
  | {
      kind: "type";
      selector: string;
      text: string;
      /** Milliseconds between characters. Default 70. */
      perCharMs?: number;
    }
  | {
      /** Just a visual click-pulse at the current cursor position. */
      kind: "click";
    }
  | {
      /** Client-side router.push — lands on a real page with demo data. */
      kind: "navigate";
      path: string;
    };

export interface DemoStep {
  atMs: number;
  caption?: string;
  cursor?: CursorTarget;
  action?: DemoAction;
}

// The whole tour, end to end. Times are cumulative from t=0 (the moment
// the visitor clicks "Start tour").
export const DEMO_TOUR: DemoStep[] = [
  // ——— Phase 1: login screen ———
  {
    atMs: 0,
    caption: "Welcome to Amaso — let's sign you in.",
    cursor: { x: 50, y: 30 },
  },
  {
    atMs: 1200,
    cursor: { selector: 'input[type="email"]' },
  },
  {
    atMs: 2000,
    caption: "Each team member has a secure account.",
    action: {
      kind: "type",
      selector: 'input[type="email"]',
      text: "santi@amaso.nl",
      perCharMs: 55,
    },
  },
  {
    atMs: 3600,
    cursor: { selector: 'input[type="password"]' },
  },
  {
    atMs: 4200,
    action: {
      kind: "type",
      selector: 'input[type="password"]',
      text: "••••••••••",
      perCharMs: 65,
    },
  },
  {
    atMs: 5800,
    caption: "One click — into the client portal.",
    cursor: { selector: 'button[type="submit"]' },
  },
  {
    atMs: 6600,
    action: { kind: "click" },
  },
  {
    atMs: 7000,
    action: { kind: "navigate", path: "/" },
  },

  // ——— Phase 2: chat / dashboard landing ———
  {
    atMs: 8000,
    caption: "This is the portal — every project, conversation, and file in one place.",
    cursor: { x: 50, y: 40 },
  },
  {
    atMs: 10500,
    caption: "Clients and the team message each other per project.",
    cursor: { x: 60, y: 50 },
  },
  {
    atMs: 13500,
    cursor: { selector: 'a[href="/projects"]' },
  },
  {
    atMs: 14400,
    action: { kind: "click" },
  },
  {
    atMs: 14800,
    action: { kind: "navigate", path: "/projects" },
  },

  // ——— Phase 3: projects grid ———
  {
    atMs: 15800,
    caption: "All active engagements, status at a glance.",
    cursor: { x: 50, y: 40 },
  },
  {
    atMs: 17800,
    cursor: { selector: 'a[href="/projects/horizon-architects"]' },
  },
  {
    atMs: 19000,
    action: { kind: "click" },
  },
  {
    atMs: 19400,
    action: { kind: "navigate", path: "/projects/horizon-architects" },
  },

  // ——— Phase 4: project detail ———
  {
    atMs: 20500,
    caption: "Every project is a live workspace — files, deploys, remarks.",
    cursor: { x: 40, y: 40 },
  },
  {
    atMs: 24000,
    caption: "Clients see exactly what's live, what's staged, what's next.",
    cursor: { x: 60, y: 55 },
  },
  {
    atMs: 27500,
    caption: "One dashboard. Every client. Always current.",
    cursor: { x: 50, y: 45 },
  },
  {
    atMs: 30500,
    caption: "That's Amaso. Let's build yours next.",
  },
];

export const DEMO_TOUR_DURATION_MS =
  Math.max(...DEMO_TOUR.map((s) => s.atMs)) + 3500;

/** Optional voiceover track. A missing file errors silently; the tour
 *  runs off its own clock regardless. Drop the real recording at
 *  `public/demo/walkthrough.mp3`. */
export const DEMO_AUDIO_SRC = "/demo/walkthrough.mp3";
