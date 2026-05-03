import fs from "node:fs";
import path from "node:path";

export type ProjectVisibility = "team" | "client" | "public";

export interface ProjectConfig {
  id: string;
  name: string;
  /**
   * Root of the code on disk (typically a Syncthing-managed folder).
   * Multiple dashboard entries can share the same `path` — use `subPath`
   * to scope each entry to a different subfolder for display, remarks, and
   * file tree purposes. The dev server and git commands always run against
   * `path` (the real repo root).
   */
  path: string;
  /**
   * Optional subfolder inside `path`. When set, the file tree, selection
   * paths, and remarks all behave as if that subfolder were the project
   * root. Useful when one codebase serves multiple clients (e.g. content
   * folders inside a shared Next.js app).
   */
  subPath?: string;
  visibility: ProjectVisibility;
  previewUrl?: string;
  liveUrl?: string;
  /**
   * Explicit local port the dev server listens on. Required when previewUrl
   * is a public HTTPS hostname (e.g. https://neva17.amaso.nl) because then
   * we can't derive the port from the URL. If omitted, we fall back to the
   * port parsed from previewUrl.
   */
  devPort?: number;
  devCommand?: string;
  deployBranch?: string;
}

export interface AmasoConfig {
  projects: ProjectConfig[];
  ignore: string[];
  /**
   * URL of an external amaso-pty-service instance. When set, all terminal
   * operations route through that service's HTTP/WS API so PTYs survive
   * dashboard restarts. When empty (default), the in-process PTY code in
   * lib/terminal.ts is used as before. Override at runtime via the
   * PTY_SERVICE_URL env var (env wins). Example: "http://127.0.0.1:7850".
   */
  ptyServiceUrl?: string;
}

/**
 * Resolve the active PTY-service URL — env var first (so an operator can
 * flip it without committing config changes), then amaso.config.json.
 * Returns an empty string when the toggle is off.
 */
export function getPtyServiceUrl(): string {
  const fromEnv = process.env.PTY_SERVICE_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    return loadConfig().ptyServiceUrl?.trim() ?? "";
  } catch {
    return "";
  }
}

const CONFIG_PATH = path.resolve(process.cwd(), "amaso.config.json");

export function loadConfig(): AmasoConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as AmasoConfig;
  parsed.projects = parsed.projects.map((p) => ({
    ...p,
    path: path.resolve(p.path).replace(/\\/g, "/"),
    subPath: p.subPath
      ? p.subPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
      : undefined,
  }));
  return parsed;
}

/** Append a new project to amaso.config.json and flush the in-memory cache.
 *  Preserves any top-level keys the file has beyond `projects`/`ignore`
 *  (e.g. the `_comment` we keep at the top). Throws on duplicate id, path
 *  validation failures, or I/O errors — the caller translates those into
 *  HTTP responses. */
export function addProject(project: ProjectConfig): void {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as AmasoConfig & Record<string, unknown>;
  if (parsed.projects.some((p) => p.id === project.id)) {
    throw new Error("duplicate_id");
  }
  parsed.projects.push(project);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__amasoWatcher?.refresh();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__amasoWs?.broadcastProjectsChanged();
}

export function removeProject(id: string): void {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as AmasoConfig & Record<string, unknown>;
  const before = parsed.projects.length;
  parsed.projects = parsed.projects.filter((p) => p.id !== id);
  if (parsed.projects.length === before) {
    throw new Error("project_not_found");
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__amasoWatcher?.refresh();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__amasoWs?.broadcastProjectsChanged();
}

/**
 * The effective filesystem root for a project entry — path + subPath when
 * set. This is what the file tree walks and what the inspector's path
 * normaliser resolves against.
 */
export function getProjectRoot(project: ProjectConfig): string {
  if (!project.subPath) return project.path;
  return `${project.path}/${project.subPath}`.replace(/\\/g, "/");
}

export function getProject(id: string): ProjectConfig | undefined {
  return loadConfig().projects.find((p) => p.id === id);
}

/**
 * Resolve a relative path inside a project, refusing anything that escapes the
 * project root (including the subPath scope when set).
 */
export function resolveInProject(
  projectId: string,
  relative: string,
): string | null {
  const project = getProject(projectId);
  if (!project) return null;
  const root = getProjectRoot(project);
  const normalisedRel = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const full = path.resolve(root, normalisedRel).replace(/\\/g, "/");
  if (full !== root && !full.startsWith(root + "/")) return null;
  return full;
}
