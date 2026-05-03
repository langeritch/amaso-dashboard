// Root template — re-mounts on every route boundary change, which
// kicks the CSS keyframe so navigations feel like a native app
// (subtle fade + slight rise) instead of a hard cut. Templates sit
// between layouts and pages: layouts persist (SparProvider, WS state,
// theme cookie), templates animate, pages render the actual route.
//
// Within a single route segment (e.g. selecting a conversation on
// /spar) the template does NOT re-mount — only the page-level state
// updates — so the chat surface, workers panel, and all open
// resources stay put. Crossing a route boundary (e.g. /spar →
// /projects) re-mounts and re-runs the fade.
//
// `prefers-reduced-motion` users get an instant render via the CSS
// rule in globals.css that nukes amaso-fade-in's transform/opacity
// keyframes (the .amaso-page wrapper there respects the same
// reduced-motion gate).

export default function RootTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="amaso-page-transition">{children}</div>;
}
