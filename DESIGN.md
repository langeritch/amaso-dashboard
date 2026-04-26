# Amaso Dashboard — Design System

Living source of truth. Update when you add/change a token, component pattern, or interaction rule. The implementer reads this; future reviews calibrate against it.

## Philosophy

Dense workspace tool, not marketing site. Calm surface hierarchy, strong typography, few colors. **Subtraction default** — every pixel earns its place. Keyboard-first, touch-ready. Same rules apply across desktop, tablet, PWA.

## Color tokens (dark, default)

| Role | Value | Usage |
|------|-------|-------|
| `--bg` | `#0b0d10` | app background |
| `--fg` | `#e6e8eb` | body text |
| Neutral scale | Tailwind `neutral-50..950` | surfaces, borders, muted text |
| Surface-1 | `bg-neutral-950` | panel/sidebar |
| Surface-2 | `bg-neutral-900` | card, input |
| Surface-3 | `bg-neutral-800` | hover, active nav |
| Border | `border-neutral-800` | default |
| Border-strong | `border-neutral-700` | focus, active |
| Muted text | `text-neutral-500` | caption, timestamp |
| Body text | `text-neutral-300/200/100` (progressive emphasis) |

**Light mode:** `html.light` toggle. Overrides in `app/globals.css:113-120+`. Accent colors keep saturation (emerald/sky/amber/violet/red still read on light).

## Semantic accents

| Color | Semantic | Example |
|-------|----------|---------|
| `emerald-400/500/900` | success, online, chat, "you" | `bg-emerald-500` unread badge |
| `sky-400` | project/file domain | project icon |
| `amber-*` | warning, pending |  |
| `violet-*` | AI/Claude context | (TBD — define usage) |
| `red-*` | error, destructive | login error |

**Rule:** Accents are semantic, not decorative. Do not use purple/violet for generic CTAs. No gradients.

## Typography

- **Font:** `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` (system stack, zero custom fonts loaded)
- **Sizes:** Tailwind defaults — `text-xs` (12), `text-sm` (14), `text-base` (16), `text-lg`. Mobile inputs forced to 16px in `globals.css:52-58` to prevent iOS zoom.
- **Micro labels:** `text-[10px]` or `text-[11px]` uppercase tracking-wide for section headers and metadata.
- **No custom heading scale** yet. Consider defining if richer content pages are added.

## Spacing & sizing

- Tailwind `rem` scale. Panels typically `px-3 py-2` (desktop) / `px-4 py-2` (wider).
- **Sidebar:** 64 (mobile drawer) / 56 (desktop persistent).
- **Borders:** 1px, `border-neutral-800` default.
- **Radii:** `rounded` (4px) for inputs, `rounded-md` (6px) for buttons/cards, `rounded-full` for badges. No large-radius bubble UI.
- **Shadows:** only on overlays (drawer, dialog). No decorative shadows.

## Components

| Component | Location | Notes |
|-----------|----------|-------|
| Topbar | `components/Topbar.tsx` | primary nav, admin shield, PWA-aware safe area |
| Sidebar | inside ProjectView | collapsible on mobile |
| Terminal | `TerminalPane.tsx` | xterm.js, touch-action: none for own gesture handling |
| Monaco editor | `FileViewer.tsx` | themed with app dark/light |
| Chat | `ChatClient.tsx` | channel + DM |
| Remarks | `RemarksPanel.tsx`, `GlobalRemarks.tsx` | project + global notes |
| Push toggle | `PushToggle.tsx` | VAPID subscription |

**New components** must: reuse the token palette above, match border+radius scale, use Lucide icons (already imported everywhere), and work on 375px viewport without overflow.

## Interaction states (required for every feature)

For each user-facing screen/panel, specify:

- **Loading:** skeleton OR inline spinner (pick one per panel, not both)
- **Empty:** warmth + primary action + context (not "No items found.")
- **Error:** red text, concrete next action (not raw stack trace)
- **Success:** brief confirmation, then return to list view
- **Partial:** skeleton for unloaded rows while known rows render

**Current gaps:** none of the cross-cutting interaction states are missing at the moment — track anything new here as it's discovered.

## Responsive

- **375px (mobile):** drawer nav, stacked content, 16px input font, safe-area padding
- **≥640px (sm):** persistent sidebar, compact text (`sm:text-sm`)
- **≥1024px (lg):** multi-column workspace (code + terminal + preview)
- **PWA:** honors `display-mode: standalone`, safe areas, iOS zoom prevention, dynamic viewport (`100dvh`)

## Accessibility

- Touch targets: **44px minimum on mobile** (currently 40px in some places — tighten)
- Keyboard: ESC closes drawer, focus-visible on all interactive elements
- Color contrast: body text meets WCAG AA (gray `neutral-300` on `neutral-950` ≈ 10:1)
- Semantic HTML: `<button>` for actions, `<a href>` for navigation, labels tied to inputs
- ARIA: audit pass needed for the custom terminal + Monaco regions

## What this design system deliberately does NOT have

- Custom web font (saves bytes, stays sharp — system fonts are excellent)
- Gradients or hero images (not a marketing site)
- Avatar/illustration system (text+initials where needed)
- Animation library (keep motion minimal; css keyframes only for specific cases like `monaco-flash-line`)
- Card-based feature grids (dense workspace > decorative cards)

## Open decisions (not yet specified)

1. **Semantic color tokens** — define `--color-success`, `--color-warning`, `--color-destructive` so Tailwind accents are swappable
2. **44px touch targets** — audit and fix remaining 40px buttons
3. **Loading skeleton pattern** — pick one approach and document it
4. **Empty state copy** — write a template ("You haven't X yet. Try Y.")
