/**
 * Unified session resolution: find a single session by ID, --last, or --source.
 * Eliminates duplicated session-finding logic across show/trace commands.
 */

import { basename, join } from "path";
import { homedir, platform } from "os";
import { readdir, stat } from "fs/promises";
import { SessionWatcher } from "./watcher.js";
import { parseSessionFile } from "./parser.js";
import { findLatestCocoSession, parseCocoSession } from "./coco-parser.js";
import type { SessionEntry } from "./types.js";

export interface ResolveOpts {
  session?: string;
  last?: boolean;
  source?: string;
}

export interface ResolvedSession {
  entries: SessionEntry[];
  sessionId: string;
  cwd?: string;
}

/**
 * Resolve a single session to its parsed entries.
 * Supports both Claude Code and Coco sources.
 * Throws with a descriptive message if no session is found.
 */
export async function resolveSession(opts: ResolveOpts): Promise<ResolvedSession> {
  if (opts.source === "coco") {
    return resolveCocoSession(opts);
  }
  return resolveClaudeSession(opts);
}

async function resolveCocoSession(opts: ResolveOpts): Promise<ResolvedSession> {
  let sessionDir: string | null = null;
  let sessionId: string = "";

  if (opts.session) {
    const base = platform() === "darwin"
      ? join(homedir(), "Library", "Caches", "coco", "sessions")
      : join(homedir(), ".cache", "coco", "sessions");
    sessionDir = join(base, opts.session);
    sessionId = opts.session;
  } else {
    const latest = await findLatestCocoSession();
    if (latest) {
      sessionDir = latest.sessionDir;
      sessionId = latest.sessionId;
    }
  }

  if (!sessionDir) {
    throw new Error("No coco session found");
  }

  const parsed = await parseCocoSession(sessionDir);
  return {
    entries: parsed.entries,
    sessionId: parsed.sessionId,
    cwd: parsed.metadata?.metadata?.cwd,
  };
}

async function resolveClaudeSession(opts: ResolveOpts): Promise<ResolvedSession> {
  let filePath: string | null = null;

  if (opts.last || !opts.session) {
    filePath = await SessionWatcher.findLatestSession();
  } else if (opts.session) {
    const projectsDir = join(homedir(), ".claude", "projects");
    const dirs = await readdir(projectsDir).catch(() => []);
    for (const d of dirs) {
      const candidate = join(projectsDir, d as string, `${opts.session}.jsonl`);
      try {
        await stat(candidate);
        filePath = candidate;
        break;
      } catch {}
    }
  }

  if (!filePath) {
    throw new Error("No session found");
  }

  const sessionId = basename(filePath, ".jsonl");
  const entries = await parseSessionFile(filePath);
  return { entries, sessionId };
}
