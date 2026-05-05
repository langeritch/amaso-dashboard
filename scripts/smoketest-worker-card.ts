// Smoke test the new hover-card fields without going through the
// auth-gated HTTP route. Imports the same backend the route uses and
// dumps the lastPrompt / lastOutputSummary / promptCount for whichever
// session is currently live in the pty-service.
import { getSession } from "../lib/terminal-backend";
import { cleanScrollback } from "../lib/spar-tools-context";

const PROMPT_TAIL_BYTES = 100_000;
const PROMPT_LINE_RX = /^[>❯$›]\s+(.+?)\s*$/;
const ACTIVITY_LINE_REGEX =
  /\b[A-Za-z]+ing\b[^\n]{0,80}\(\s*(?:[^()]*?\s)?(?:\d+\s*m\s+)?\d+\s*s\b/i;

function extractPrompts(cleaned: string) {
  const lines = cleaned.split(/\r?\n/);
  let count = 0;
  let last = "";
  for (let i = lines.length - 1; i >= 0 && count < 500; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = PROMPT_LINE_RX.exec(line);
    if (!m) continue;
    const body = m[1].trim();
    if (!body || /^\.{1,3}$/.test(body)) continue;
    if (!last) last = body;
    count++;
  }
  if (last.length > 80) last = last.slice(0, 77) + "…";
  return { count, last };
}

function pickOutputSummary(clean: string) {
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-16);
  const cap = (s: string) => (s.length > 220 ? s.slice(0, 217) + "…" : s);
  const COMPLETION_RX = /\w+(?:ed|t)\s+for\s+(?:\d+\s*m\s+)?\d+\s*s/i;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line) continue;
    if (PROMPT_LINE_RX.test(line)) continue;
    if (COMPLETION_RX.test(line)) continue;
    if (ACTIVITY_LINE_REGEX.test(line)) continue;
    if (/^[>│▌$›❯]\s*$/.test(line)) continue;
    return cap(line);
  }
  return "";
}

const projectId = process.argv[2] ?? "dashboard-sparring-partner";
const sess = getSession(projectId);
if (!sess) {
  console.log(`no session for ${projectId}`);
  process.exit(0);
}
const sb = sess.scrollback;
const tail = sb.slice(Math.max(0, sb.length - PROMPT_TAIL_BYTES));
const cleaned = cleanScrollback(tail);
const prompts = extractPrompts(cleaned);
const summary = pickOutputSummary(cleaned);
console.log(JSON.stringify({
  projectId,
  scrollbackBytes: sb.length,
  cleanedBytes: cleaned.length,
  promptCount: prompts.count,
  lastPrompt: prompts.last,
  lastOutputSummary: summary,
}, null, 2));
