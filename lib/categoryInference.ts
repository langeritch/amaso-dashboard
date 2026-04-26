// Smart category inference for remarks. Priority order:
//   1. File extension        — if the remark is on a file, the extension wins
//   2. Path fragments        — components/ → frontend, api/ → backend, etc.
//   3. Body keyword scan     — "css"/"button" vs "api"/"database"
//   4. Fallback              — keep whatever was already there, default frontend
//
// Returns both the inferred category AND a confidence flag so the UI can
// show a subtle "auto" badge when it's a strong signal.

export type Category = "frontend" | "backend" | "other";

const FRONTEND_EXTS = new Set([
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  "postcss",
  "html",
  "htm",
  "xhtml",
  "jsx",
  "tsx",
  "vue",
  "svelte",
  "astro",
  // Assets that a designer/frontend dev usually owns
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mdx",
]);

const BACKEND_EXTS = new Set([
  "py",
  "pyc",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "scala",
  "cs",
  "php",
  "sql",
  "psql",
  "pl",
  "ex",
  "exs",
  "erl",
  "c",
  "cpp",
  "h",
  "hpp",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "psm1",
]);

const FRONTEND_BASENAMES = new Set([
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "postcss.config.mjs",
]);

const BACKEND_BASENAMES = new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".env",
  ".env.local",
  ".env.production",
  "nginx.conf",
  "makefile",
]);

// Substring hints — checked against the full lowercased path. Order matters:
// we test backend BEFORE frontend so `app/api/...` resolves to backend, not
// frontend on the `app/` portion.
const BACKEND_PATH_HINTS = [
  "/api/",
  "api/", // path starts with api/
  "/server/",
  "server/",
  "/backend/",
  "backend/",
  "/routes/",
  "routes/",
  "/controllers/",
  "controllers/",
  "/models/",
  "models/",
  "/migrations/",
  "migrations/",
  "/database/",
  "database/",
  "/middleware/",
  "middleware/",
  "/schemas/",
  "schemas/",
  "/services/",
  "services/",
  "/workers/",
  "workers/",
];

const FRONTEND_PATH_HINTS = [
  "/components/",
  "components/",
  "/pages/",
  "pages/",
  "/ui/",
  "ui/",
  "/client/",
  "client/",
  "/frontend/",
  "frontend/",
  "/web/",
  "web/",
  "/views/",
  "views/",
  "/templates/",
  "templates/",
  "/styles/",
  "styles/",
  "/assets/",
  "assets/",
  "/public/",
  "public/",
  "/static/",
  "static/",
  "/stories/",
  "stories/",
];

// Keyword scan on body text. Use word boundaries to avoid "api"/"apiece".
const FRONTEND_KEYWORDS = [
  "css",
  "html",
  "tailwind",
  "sass",
  "scss",
  "button",
  "buttons",
  "font",
  "fonts",
  "color",
  "colors",
  "colour",
  "colours",
  "style",
  "styles",
  "styling",
  "layout",
  "responsive",
  "mobile",
  "desktop",
  "tablet",
  "design",
  "image",
  "images",
  "icon",
  "icons",
  "logo",
  "banner",
  "hero",
  "header",
  "footer",
  "navbar",
  "nav",
  "menu",
  "sidebar",
  "hover",
  "click",
  "scroll",
  "animation",
  "transition",
  "modal",
  "dialog",
  "popup",
  "tooltip",
  "dropdown",
  "form",
  "input",
  "checkbox",
  "radio",
  "placeholder",
  "label",
  "page",
  "ui",
  "ux",
  "figma",
  "pixel",
  "alignment",
  "padding",
  "margin",
  "border",
  "shadow",
  "gradient",
  "background",
  "typography",
  "breakpoint",
  "grid",
  "flex",
  "flexbox",
  "viewport",
  "blurry",
  "broken layout",
  "alignment",
];

const BACKEND_KEYWORDS = [
  "api",
  "apis",
  "endpoint",
  "endpoints",
  "rest",
  "graphql",
  "database",
  "query",
  "sql",
  "sqlite",
  "postgres",
  "mysql",
  "mongo",
  "auth",
  "authentication",
  "authorization",
  "jwt",
  "session",
  "sessions",
  "cookie",
  "cookies",
  "csrf",
  "cors",
  "cache",
  "redis",
  "performance",
  "latency",
  "throughput",
  "500",
  "502",
  "503",
  "timeout",
  "server",
  "deploy",
  "deployment",
  "build",
  "env",
  "environment",
  "secret",
  "secrets",
  "migration",
  "migrations",
  "schema",
  "email",
  "smtp",
  "imap",
  "mail",
  "dns",
  "mx",
  "spf",
  "dkim",
  "cron",
  "queue",
  "worker",
  "docker",
  "kubernetes",
  "ssh",
  "ssl",
  "certificate",
  "nginx",
  "apache",
  "proxy",
  "logs",
  "logging",
  "sentry",
  "webhook",
  "webhooks",
  "rate limit",
  "middleware",
];

export interface InferenceResult {
  category: Category;
  /** Strong signal? Used to decide whether to show the "auto" hint. */
  confident: boolean;
  /** Short reason string — handy for tooltips. */
  reason: string;
}

export function inferCategory({
  path,
  body,
  fallback = "frontend",
}: {
  path?: string | null;
  body?: string;
  fallback?: Category;
}): InferenceResult {
  // 1. Filename / basename
  if (path) {
    const base = path.split("/").pop()?.toLowerCase() ?? "";
    if (FRONTEND_BASENAMES.has(base)) {
      return {
        category: "frontend",
        confident: true,
        reason: `filename "${base}" is frontend tooling`,
      };
    }
    if (BACKEND_BASENAMES.has(base)) {
      return {
        category: "backend",
        confident: true,
        reason: `filename "${base}" is infra / backend`,
      };
    }

    // 2. Extension
    const ext = base.includes(".") ? base.split(".").pop()! : "";
    if (FRONTEND_EXTS.has(ext)) {
      return {
        category: "frontend",
        confident: true,
        reason: `.${ext} file`,
      };
    }
    if (BACKEND_EXTS.has(ext)) {
      return {
        category: "backend",
        confident: true,
        reason: `.${ext} file`,
      };
    }

    // 3. Path fragments — backend first so Next.js `app/api/...` wins
    const normPath = path.toLowerCase().replace(/^\.?\/+/, "");
    for (const hint of BACKEND_PATH_HINTS) {
      if (normPath.includes(hint)) {
        return {
          category: "backend",
          confident: true,
          reason: `path contains "${hint.replace(/\//g, "")}"`,
        };
      }
    }
    for (const hint of FRONTEND_PATH_HINTS) {
      if (normPath.includes(hint)) {
        return {
          category: "frontend",
          confident: true,
          reason: `path contains "${hint.replace(/\//g, "")}"`,
        };
      }
    }
    // Path without hints but with a known neutral ext (.ts/.js/.json/.md) —
    // fall through to body text scoring.
  }

  // 4. Body keyword scan
  if (body && body.trim()) {
    const text = body.toLowerCase();
    const { score: feScore, hit: feHit } = scoreKeywords(text, FRONTEND_KEYWORDS);
    const { score: beScore, hit: beHit } = scoreKeywords(text, BACKEND_KEYWORDS);
    if (feScore > beScore && feScore > 0) {
      return {
        category: "frontend",
        confident: feScore >= 2,
        reason: `mentions "${feHit}"`,
      };
    }
    if (beScore > feScore && beScore > 0) {
      return {
        category: "backend",
        confident: beScore >= 2,
        reason: `mentions "${beHit}"`,
      };
    }
  }

  // 5. Fallback
  return { category: fallback, confident: false, reason: "no strong signal" };
}

function scoreKeywords(
  text: string,
  keywords: string[],
): { score: number; hit: string } {
  let score = 0;
  let hit = "";
  for (const kw of keywords) {
    // `\b` works on ASCII word chars; adequate for our keywords
    const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i");
    if (re.test(text)) {
      score++;
      if (!hit) hit = kw;
    }
  }
  return { score, hit };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
