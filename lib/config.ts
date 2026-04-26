import fs from "node:fs";
import path from "node:path";
import { DEMO_PROJECTS } from "./demo/data";

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
}

const CONFIG_PATH = path.resolve(process.cwd(), "amaso.config.json");

let cached: AmasoConfig | null = null;

export function loadConfig(): AmasoConfig {
  if (cached) return cached;
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as AmasoConfig;
  // Normalise paths to absolute + forward slashes for consistent comparisons
  parsed.projects = parsed.projects.map((p) => ({
    ...p,
    path: path.resolve(p.path).replace(/\\/g, "/"),
    subPath: p.subPath
      ? p.subPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
      : undefined,
  }));
  cached = parsed;
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
  cached = null;
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
  const real = loadConfig().projects.find((p) => p.id === id);
  if (real) return real;
  // Demo-mode project shims — synthetic ProjectConfig rows keyed off the
  // fake project IDs so getProject() in /projects/[id] resolves for demo
  // users without touching amaso.config.json.
  const d = DEMO_PROJECTS.find((p) => p.id === id);
  if (!d) return undefined;
  return {
    id: d.id,
    name: d.name,
    path: `/demo/${d.id}`,
    visibility: "team",
  };
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
