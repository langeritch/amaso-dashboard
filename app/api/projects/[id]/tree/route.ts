import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { getProject, getProjectRoot, loadConfig } from "@/lib/config";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";

export const dynamic = "force-dynamic";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
  size?: number;
}

const MAX_ENTRIES = 5000;

async function walk(
  absRoot: string,
  absDir: string,
  ig: ReturnType<typeof ignore>,
  counter: { n: number },
): Promise<TreeNode[]> {
  if (counter.n >= MAX_ENTRIES) return [];
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: TreeNode[] = [];
  for (const entry of entries) {
    if (counter.n >= MAX_ENTRIES) break;
    const abs = path.join(absDir, entry.name);
    const rel = path.relative(absRoot, abs).replace(/\\/g, "/");
    if (ig.ignores(rel)) continue;
    counter.n++;
    if (entry.isDirectory()) {
      out.push({
        name: entry.name,
        path: rel,
        type: "dir",
        children: await walk(absRoot, abs, ig, counter),
      });
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        /* swallow */
      }
      out.push({ name: entry.name, path: rel, type: "file", size });
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const project = getProject(id);
  if (!project) {
    return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  }
  const root = getProjectRoot(project);
  const ig = ignore().add(loadConfig().ignore);
  const counter = { n: 0 };
  const tree = await walk(root, root, ig, counter);
  return NextResponse.json({
    projectId: id,
    truncated: counter.n >= MAX_ENTRIES,
    tree,
  });
}
