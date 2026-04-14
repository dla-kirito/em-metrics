/**
 * Unified session collection — scans Claude Code or Coco sessions,
 * applies date-range filters, and returns raw entries.
 *
 * Consumers that need EvalSessionMetrics should map over the result:
 *   items.map(s => extractMetrics(s.entries, s.sessionId))
 */

import { basename, join } from "path";
import { homedir } from "os";
import { readdir, stat } from "fs/promises";
import { parseSessionFile } from "./parser.js";
import { findCocoSessions, parseCocoSession } from "./coco-parser.js";
import { extractMetrics } from "./metrics.js";
import { createProgress } from "./progress.js";
import type { SessionEntry, EvalSessionMetrics } from "./types.js";
import chalk from "chalk";

export interface SessionEntriesItem {
  sessionId: string;
  entries: SessionEntry[];
  cwd?: string;
}

export interface CollectOpts {
  source?: string;
  cwd?: string;
  since?: string;
  until?: string;
}

/**
 * Collect raw session entries from Claude Code or Coco sources.
 */
export async function collectSessionEntries(
  opts: CollectOpts
): Promise<SessionEntriesItem[]> {
  const result: SessionEntriesItem[] = [];
  const progress = createProgress();
  let skipped = 0;

  if (opts.source === "coco") {
    progress.update("Scanning coco sessions...");
    const sessions = await findCocoSessions({
      cwd: opts.cwd,
      since: opts.since,
      until: opts.until,
    });

    for (let i = 0; i < sessions.length; i++) {
      progress.update(`Processing sessions... ${i + 1}/${sessions.length}`);
      try {
        const parsed = await parseCocoSession(sessions[i].sessionDir);
        if (parsed.entries.length === 0) continue;
        result.push({
          sessionId: parsed.sessionId,
          entries: parsed.entries,
          cwd: parsed.metadata?.metadata?.cwd,
        });
      } catch (e) {
        skipped++;
      }
    }
    progress.stop();
  } else {
    const projectsDir = join(homedir(), ".claude", "projects");
    const dirs = await readdir(projectsDir).catch(() => []);

    // Phase 1: scan and filter files by date
    const candidates: string[] = [];
    for (let di = 0; di < dirs.length; di++) {
      progress.update(`Scanning directories... ${di + 1}/${dirs.length}`);
      const dirPath = join(projectsDir, dirs[di] as string);
      try {
        const files = await readdir(dirPath);
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const fp = join(dirPath, f);
          const s = await stat(fp);
          const dateStr = s.mtime.toISOString().slice(0, 10);
          if (opts.since && dateStr < opts.since) continue;
          if (opts.until && dateStr > opts.until) continue;
          candidates.push(fp);
        }
      } catch (e) {
        // directory read failed, skip
      }
    }

    // Phase 2: parse matched files
    for (let i = 0; i < candidates.length; i++) {
      progress.update(`Processing sessions... ${i + 1}/${candidates.length}`);
      try {
        const entries = await parseSessionFile(candidates[i]);
        if (entries.length === 0) continue;
        const sessionId = basename(candidates[i], ".jsonl");
        let cwd: string | undefined;
        for (const entry of entries) {
          if (entry.type === "user" && (entry as any).cwd) {
            cwd = (entry as any).cwd;
            break;
          }
        }
        result.push({ sessionId, entries, cwd });
      } catch (e) {
        skipped++;
      }
    }
    progress.stop();
  }

  if (skipped > 0) {
    process.stderr.write(
      chalk.yellow(`  Skipped ${skipped} session(s) due to parse errors.\n`)
    );
  }

  return result;
}

/**
 * Collect sessions and extract metrics in one step.
 * Convenience wrapper for commands that only need EvalSessionMetrics.
 */
export async function collectSessionMetrics(
  opts: CollectOpts
): Promise<EvalSessionMetrics[]> {
  const items = await collectSessionEntries(opts);
  const metrics: EvalSessionMetrics[] = [];
  for (const item of items) {
    const m = extractMetrics(item.entries, item.sessionId);
    if (m.api_calls > 0) metrics.push(m);
  }
  return metrics;
}
