/**
 * Companion task registry.
 *
 * Surfaces every in-flight companion command (shell.exec, fs.read,
 * screenshot, input.click, etc.) as a visible row in the workers
 * panel. Hooked from companion-ws.sendCommandToDevice: register a
 * task before the command is sent, complete or fail it when the ack
 * lands. Mirrors the lib/browser-jobs.ts pattern so the workers-
 * panel rendering stays uniform.
 *
 * In-memory only, per-user. Terminal-state rows (completed / failed)
 * stay around for 5 minutes so the panel can fade them out gracefully
 * before the registry drops them.
 */
import crypto from "node:crypto";

import type { CompanionCommand } from "./companion-ws";

export type CompanionTaskStatus = "running" | "completed" | "failed";

export interface CompanionTask {
  id: string;
  userId: number;
  /** UUID from companion-devices. May be null when the dispatch went
   *  out without targeting a specific device (rare, but the registry
   *  handles it cleanly). */
  deviceId: string | null;
  /** Human label snapshot from companion-devices at register time so
   *  the workers panel doesn't need a second lookup per row. Falls
   *  back to "Unknown device" when the device hasn't registered
   *  itself yet. */
  deviceName: string;
  /** Wire-level command type: shell.exec, fs.read, screenshot, input.type, ... */
  commandType: CompanionCommand["type"];
  /** Pre-built friendly description for the panel ("Running ls ~ on
   *  MacBook"). Built off the command at register time; we don't
   *  recompute on render. */
  description: string;
  status: CompanionTaskStatus;
  startedAt: number;
  completedAt: number | null;
  /** One-line result summary the panel shows under the description.
   *  Empty until the command lands. */
  resultSummary: string;
}

const TERMINAL_FADE_MS = 5 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __amasoCompanionTasks: Map<number, Map<string, CompanionTask>> | undefined;
}

function store(): Map<number, Map<string, CompanionTask>> {
  if (!globalThis.__amasoCompanionTasks) {
    globalThis.__amasoCompanionTasks = new Map();
  }
  return globalThis.__amasoCompanionTasks;
}

function tasksFor(userId: number): Map<string, CompanionTask> {
  const all = store();
  let mine = all.get(userId);
  if (!mine) {
    mine = new Map();
    all.set(userId, mine);
  }
  return mine;
}

/** Sweep terminal-state rows older than TERMINAL_FADE_MS. Called on
 *  every read so the registry stays bounded without a cron. Running
 *  tasks are left alone, even if they look stuck; the dispatch path
 *  is responsible for hitting them with failTask on its timeout. */
function sweep(userId: number): void {
  const now = Date.now();
  const mine = tasksFor(userId);
  for (const [id, task] of mine) {
    if (task.status === "running") continue;
    if (task.completedAt != null && now - task.completedAt > TERMINAL_FADE_MS) {
      mine.delete(id);
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Build a one-line panel-ready description from a CompanionCommand
 *  + the device name. Kept here so the dispatch site doesn't need to
 *  know about every command shape. */
export function buildTaskDescription(
  command: CompanionCommand,
  deviceName: string,
): string {
  const target = ` on ${deviceName}`;
  switch (command.type) {
    case "shell.exec":
      return `Running ${truncate(command.cmd.trim(), 60)}${target}`;
    case "fs.read":
      return `Reading ${truncate(command.path, 60)}${target}`;
    case "fs.read.binary":
      return `Reading binary ${truncate(command.path, 60)}${target}`;
    case "fs.write":
      return `Writing ${truncate(command.path, 60)}${target}`;
    case "screenshot": {
      const region = command.region;
      if (region) {
        return `Screenshot ${region.width}x${region.height}${target}`;
      }
      const resize = command.resize;
      return `Screenshot${resize ? ` (${resize}px)` : ""}${target}`;
    }
    case "input.type":
      return `Typing ${truncate(command.text, 40)}${target}`;
    case "input.key": {
      const mods = command.modifiers ?? [];
      const chord = mods.length > 0 ? `${mods.join("+")}+${command.key}` : command.key;
      return `Pressing ${chord}${target}`;
    }
    case "input.click":
      return `Clicking ${Math.round(command.x)},${Math.round(command.y)}${target}`;
    case "input.move":
      return `Moving cursor to ${Math.round(command.x)},${Math.round(command.y)}${target}`;
    case "audio.duck":
      return `Ducking audio${target}`;
    case "audio.restore":
      return `Restoring audio${target}`;
    default: {
      // exhaustive switch as a safety net for future variants
      const t = (command as { type?: string }).type ?? "command";
      return `${t}${target}`;
    }
  }
}

export interface RegisterTaskInput {
  userId: number;
  deviceId: string | null;
  deviceName: string;
  command: CompanionCommand;
}

export function registerTask(input: RegisterTaskInput): CompanionTask {
  const id = `ctk_${crypto.randomBytes(6).toString("base64url")}`;
  const now = Date.now();
  const task: CompanionTask = {
    id,
    userId: input.userId,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    commandType: input.command.type,
    description: buildTaskDescription(input.command, input.deviceName),
    status: "running",
    startedAt: now,
    completedAt: null,
    resultSummary: "",
  };
  tasksFor(input.userId).set(id, task);
  return task;
}

export function completeTask(
  userId: number,
  id: string,
  summary?: string,
): CompanionTask | null {
  const task = tasksFor(userId).get(id);
  if (!task) return null;
  task.status = "completed";
  task.completedAt = Date.now();
  if (summary) task.resultSummary = truncate(summary, 200);
  return task;
}

export function failTask(
  userId: number,
  id: string,
  reason?: string,
): CompanionTask | null {
  const task = tasksFor(userId).get(id);
  if (!task) return null;
  task.status = "failed";
  task.completedAt = Date.now();
  if (reason) task.resultSummary = truncate(reason, 200);
  return task;
}

export function getActiveTasks(userId: number): CompanionTask[] {
  sweep(userId);
  return Array.from(tasksFor(userId).values()).sort(
    (a, b) => b.startedAt - a.startedAt,
  );
}

/** Build a one-line summary from the ack result. Walks a few common
 *  shapes (shell.exec exitCode, fs.read content length, screenshot
 *  bytes) so the panel shows something useful without the dispatch
 *  site having to understand every result. */
export function summariseAckResult(
  command: CompanionCommand,
  result: unknown,
): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (command.type === "shell.exec") {
    const code = typeof r.exitCode === "number" ? r.exitCode : null;
    if (code === null) return "completed";
    return code === 0 ? "exit 0" : `exit ${code}`;
  }
  if (command.type === "fs.read") {
    const content = typeof r.content === "string" ? r.content : null;
    if (content !== null) return `${content.length} chars`;
    return "completed";
  }
  if (command.type === "fs.read.binary") {
    const content =
      typeof r.content === "string"
        ? r.content
        : typeof r.data === "string"
          ? r.data
          : "";
    if (content) return `${Math.round(content.length * 0.75)} bytes`;
    return "completed";
  }
  if (command.type === "fs.write") {
    const size = typeof r.size === "number" ? r.size : null;
    return size !== null ? `${size} bytes written` : "written";
  }
  if (command.type === "screenshot") {
    const w = typeof r.width === "number" ? r.width : null;
    return w !== null ? `${w}px wide` : "captured";
  }
  if (command.type.startsWith("input.")) return "ok";
  return "completed";
}
