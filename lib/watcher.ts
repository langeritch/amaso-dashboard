import chokidar, { type FSWatcher } from "chokidar";
import ignore from "ignore";
import path from "node:path";
import { EventEmitter } from "node:events";
import { loadConfig, type ProjectConfig } from "./config";

export type FileEvent = {
  type: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  projectId: string;
  relPath: string;
  /** Absolute path on disk. Not exposed to the web client. */
  absPath: string;
};

class ProjectWatcher extends EventEmitter {
  // One chokidar instance per unique real path — two project entries
  // sharing the same codebase (different subPaths) only need one watch.
  private watchers = new Map<string, FSWatcher>();
  private ig = ignore();
  private ready = false;

  start() {
    const config = loadConfig();
    this.ig = ignore().add(config.ignore);

    // Group projects by their real on-disk path
    const byPath = new Map<string, ProjectConfig[]>();
    for (const project of config.projects) {
      const arr = byPath.get(project.path) ?? [];
      arr.push(project);
      byPath.set(project.path, arr);
    }
    for (const [realPath, projects] of byPath) {
      this.watchPath(realPath, projects);
    }
  }

  private watchPath(realPath: string, projects: ProjectConfig[]) {
    const watcher = chokidar.watch(realPath, {
      ignored: (filePath: string) => {
        if (filePath === realPath) return false;
        const rel = path.relative(realPath, filePath).replace(/\\/g, "/");
        if (!rel) return false;
        // Anything resolving outside the watched root must be ignored —
        // the `ignore` library throws RangeError on a leading "..", and
        // chokidar's unhandled rejection then cascades through Node's
        // microtask queue. Saw this take down the prod server: every
        // invalid event allocated a fresh promise + error object,
        // ballooning RSS by ~350 MB/s until the heap cap killed us.
        if (rel === ".." || rel.startsWith("../")) return true;
        try {
          return this.ig.ignores(rel);
        } catch {
          // Defensive: any future quirk in the ignore lib must not
          // throw out of the chokidar filter. Treat as "not ignored".
          return false;
        }
      },
      // We pre-populate baselines via lib/history.seedFromConfig() before
      // the watcher starts. With ignoreInitial:false chokidar would re-emit
      // an `add` for every existing file on startup, each one then triggers
      // a fs.readFile through history.record() — for ~5 codebases × thousands
      // of files this allocated gigabytes of strings in seconds and OOM-killed
      // the Node process within ~2 minutes of boot. ignoreInitial:true skips
      // the redundant flood.
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const emit = (type: FileEvent["type"]) => (absPath: string) => {
      const normAbs = absPath.replace(/\\/g, "/");
      // For each project entry that scopes to this real path, emit an
      // event when the change falls inside that entry's subPath window.
      for (const project of projects) {
        const scopeRoot = project.subPath
          ? `${realPath}/${project.subPath}`
          : realPath;
        if (
          normAbs !== scopeRoot &&
          !normAbs.startsWith(scopeRoot + "/")
        ) {
          continue;
        }
        const rel = path.relative(scopeRoot, normAbs).replace(/\\/g, "/");
        this.emit("file", {
          type,
          projectId: project.id,
          relPath: rel,
          absPath: normAbs,
        } satisfies FileEvent);
      }
    };

    watcher
      .on("add", emit("add"))
      .on("change", emit("change"))
      .on("unlink", emit("unlink"))
      .on("addDir", emit("addDir"))
      .on("unlinkDir", emit("unlinkDir"))
      .on("ready", () => {
        this.ready = true;
        for (const p of projects) this.emit("ready", p.id);
        console.log(
          `[watcher] ready: ${projects.map((p) => p.id).join(", ")} (${realPath})`,
        );
      })
      .on("error", (err) => console.error("[watcher] error:", err));

    this.watchers.set(realPath, watcher);
  }

  refresh() {
    const config = loadConfig();
    this.ig = ignore().add(config.ignore);
    const byPath = new Map<string, ProjectConfig[]>();
    for (const project of config.projects) {
      const arr = byPath.get(project.path) ?? [];
      arr.push(project);
      byPath.set(project.path, arr);
    }
    for (const [realPath, projects] of byPath) {
      if (!this.watchers.has(realPath)) {
        this.watchPath(realPath, projects);
      }
    }
    for (const [realPath, watcher] of this.watchers) {
      if (!byPath.has(realPath)) {
        void watcher.close();
        this.watchers.delete(realPath);
      }
    }
  }

  async stop() {
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  isReady() {
    return this.ready;
  }
}

// Pin to globalThis so the custom server, WS, and API routes share one watcher.
declare global {
  // eslint-disable-next-line no-var
  var __amasoWatcher: ProjectWatcher | undefined;
}

export function getWatcher(): ProjectWatcher {
  if (!globalThis.__amasoWatcher) {
    globalThis.__amasoWatcher = new ProjectWatcher();
  }
  return globalThis.__amasoWatcher;
}
