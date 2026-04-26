import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { apiRequireAdmin, apiRequireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import {
  addProject,
  type ProjectConfig,
  type ProjectVisibility,
} from "@/lib/config";

/** Where new projects land when the admin doesn't pick a path. Env overrides;
 *  the fallback assumes the dashboard itself lives inside the projects
 *  folder (e.g. C:/Users/santi/projects/amaso-dashboard), which matches
 *  how this install is set up. */
function defaultProjectsRoot(): string {
  const envRoot = process.env.AMASO_PROJECTS_ROOT?.trim();
  if (envRoot) return path.resolve(envRoot).replace(/\\/g, "/");
  return path.resolve(process.cwd(), "..").replace(/\\/g, "/");
}

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  return NextResponse.json({
    projects: visibleProjects(auth.user).map((p) => ({
      id: p.id,
      name: p.name,
      visibility: p.visibility,
    })),
  });
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export async function POST(req: Request) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  let body: Partial<ProjectConfig>;
  try {
    body = (await req.json()) as Partial<ProjectConfig>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const rawPath = typeof body.path === "string" ? body.path.trim() : "";
  const visibility = (body.visibility ?? "team") as ProjectVisibility;

  if (!ID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: "invalid_id", hint: "lowercase letters, digits, dashes only" },
      { status: 400 },
    );
  }
  if (!name) {
    return NextResponse.json({ error: "missing_name" }, { status: 400 });
  }
  if (!["team", "client", "public"].includes(visibility)) {
    return NextResponse.json({ error: "invalid_visibility" }, { status: 400 });
  }

  // Either the admin supplied a path (must exist + be a dir), or we pick a
  // default under the projects root and create a fresh empty dir for them.
  let diskPath: string;
  if (rawPath) {
    try {
      const stat = fs.statSync(rawPath);
      if (!stat.isDirectory()) {
        return NextResponse.json(
          { error: "path_not_directory" },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json({ error: "path_not_found" }, { status: 400 });
    }
    diskPath = rawPath;
  } else {
    const root = defaultProjectsRoot();
    const candidate = `${root}/${id}`;
    if (fs.existsSync(candidate)) {
      return NextResponse.json(
        { error: "auto_path_exists", path: candidate },
        { status: 409 },
      );
    }
    try {
      fs.mkdirSync(candidate, { recursive: true });
    } catch (err) {
      // Log filesystem detail server-side; the JSON response stays
      // a generic error code so we don't leak the disk path
      // structure (`EACCES on /home/foo/...`) to authenticated but
      // potentially-untrusted users.
      console.error("[api/projects POST] mkdir failed:", candidate, err);
      return NextResponse.json({ error: "mkdir_failed" }, { status: 500 });
    }
    diskPath = candidate;
  }

  const project: ProjectConfig = { id, name, path: diskPath, visibility };
  if (typeof body.subPath === "string" && body.subPath.trim()) {
    project.subPath = body.subPath.trim();
  }
  if (typeof body.previewUrl === "string" && body.previewUrl.trim()) {
    project.previewUrl = body.previewUrl.trim();
  }
  if (typeof body.liveUrl === "string" && body.liveUrl.trim()) {
    project.liveUrl = body.liveUrl.trim();
  }
  if (typeof body.devPort === "number" && Number.isInteger(body.devPort)) {
    project.devPort = body.devPort;
  }
  if (typeof body.devCommand === "string" && body.devCommand.trim()) {
    project.devCommand = body.devCommand.trim();
  }
  if (typeof body.deployBranch === "string" && body.deployBranch.trim()) {
    project.deployBranch = body.deployBranch.trim();
  }

  try {
    addProject(project);
  } catch (err) {
    if (err instanceof Error && err.message === "duplicate_id") {
      return NextResponse.json({ error: "duplicate_id" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "write_failed", message: String(err) },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, project });
}
