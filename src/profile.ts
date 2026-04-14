import chalk from "chalk";
import type {
  SessionEntry,
  ProfileOutput,
  ModuleProfile,
  FileHotspot,
  TraceStep,
} from "./types.js";
import { isAssistantWithUsage } from "./parser.js";
import { computeCostUsd } from "./pricing.js";

interface SessionData {
  sessionId: string;
  entries: SessionEntry[];
  cwd?: string;
}

interface ProfileOpts {
  depth?: number;
}

/** Lightweight per-session extraction: only what profile needs. */
function extractProfileData(entries: SessionEntry[], sessionId: string) {
  const toolOps: { name: string; arg: string }[] = [];
  let correctionCount = 0;
  let lastStopReason = "";
  let lastEntryWasAssistant = false;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let model = "unknown";
  let userTurns = 0;
  let turns = 0;
  const seenIds = new Set<string>();

  for (const entry of entries) {
    if (isAssistantWithUsage(entry)) {
      const msg = entry.message;
      const msgId = msg.id;
      if (msgId && seenIds.has(msgId)) continue;
      if (msgId) seenIds.add(msgId);

      if (msg.model) model = msg.model;
      const usage = msg.usage!;
      totalInput += usage.input_tokens;
      totalOutput += usage.output_tokens;
      totalCacheRead += usage.cache_read_input_tokens ?? 0;
      totalCacheCreate += usage.cache_creation_input_tokens ?? 0;
      if (msg.stop_reason) lastStopReason = msg.stop_reason;
      if (!(entry as any).isSidechain) turns++;

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          const arg = input.file_path ? String(input.file_path) : "";
          toolOps.push({ name: block.name, arg });
        }
      }
      lastEntryWasAssistant = true;
    } else if (entry.type === "user" && "message" in entry) {
      const msg = (entry as any).message;
      let hasRealText = false;
      if (typeof msg?.content === "string" && msg.content.trim()) {
        hasRealText = true;
      } else if (Array.isArray(msg?.content)) {
        for (const b of msg.content) {
          if (b.type === "text" && b.text?.trim()) { hasRealText = true; break; }
        }
      }
      if (hasRealText) {
        userTurns++;
        if (lastEntryWasAssistant && lastStopReason === "end_turn" && turns > 1) {
          correctionCount++;
        }
      }
      lastEntryWasAssistant = false;
    } else {
      lastEntryWasAssistant = false;
    }
  }

  const abandonment = lastStopReason !== "end_turn" && lastStopReason !== "" && lastStopReason !== "tool_use";
  const costUsd = computeCostUsd(model, totalInput, totalOutput, totalCacheRead, totalCacheCreate);

  return { toolOps, correctionCount, abandonment, costUsd };
}

/**
 * Build a codebase × agent capability profile from multiple sessions.
 */
export function buildProfile(
  sessions: SessionData[],
  opts?: ProfileOpts
): ProfileOutput {
  const depth = opts?.depth ?? 2;

  // Per-module accumulators
  const moduleMap = new Map<string, {
    sessions: Set<string>;
    edits: number;
    reads: number;
    editFiles: Map<string, number>; // file → edit count within module across sessions
    editFilesPerSession: Map<string, Set<string>>; // sessionId → set of files edited
    sessionCorrections: number;   // sessions with corrections that touch this module
    sessionAbandoned: number;
    totalCost: number;
  }>();

  // Per-file accumulators
  const fileMap = new Map<string, {
    edits: number;
    sessions: Set<string>;
    reEditSessions: number; // sessions where this file was edited 2+ times
  }>();

  let totalCostAccum = 0;

  for (const session of sessions) {
    const { entries, sessionId, cwd } = session;
    const { toolOps, correctionCount, abandonment, costUsd } = extractProfileData(entries, sessionId);
    totalCostAccum += costUsd;

    // Collect file operations
    const sessionEditFiles = new Map<string, number>(); // file → edit count in this session
    const sessionReadDirs = new Set<string>();
    const sessionEditDirs = new Set<string>();

    for (const op of toolOps) {
      if (!op.arg) continue;
      const relPath = normalizePath(op.arg, cwd);
      const dir = truncateToDepth(relPath, depth);

      if (op.name === "Edit" || op.name === "Write") {
        sessionEditFiles.set(relPath, (sessionEditFiles.get(relPath) ?? 0) + 1);
        sessionEditDirs.add(dir);

        // File-level tracking
        if (!fileMap.has(relPath)) {
          fileMap.set(relPath, { edits: 0, sessions: new Set(), reEditSessions: 0 });
        }
        const f = fileMap.get(relPath)!;
        f.edits++;
        f.sessions.add(sessionId);
      } else if (op.name === "Read" || op.name === "Grep" || op.name === "Glob") {
        sessionReadDirs.add(dir);
      }
    }

    // Aggregate into modules
    const allDirs = new Set([...sessionEditDirs, ...sessionReadDirs]);
    for (const dir of allDirs) {
      if (!moduleMap.has(dir)) {
        moduleMap.set(dir, {
          sessions: new Set(),
          edits: 0,
          reads: 0,
          editFiles: new Map(),
          editFilesPerSession: new Map(),
          sessionCorrections: 0,
          sessionAbandoned: 0,
          totalCost: 0,
        });
      }
      const mod = moduleMap.get(dir)!;
      mod.sessions.add(sessionId);

      if (sessionEditDirs.has(dir)) {
        // Count edits in this dir
        for (const [file, count] of sessionEditFiles) {
          if (truncateToDepth(file, depth) === dir) {
            mod.edits += count;
            mod.editFiles.set(file, (mod.editFiles.get(file) ?? 0) + count);
            if (!mod.editFilesPerSession.has(sessionId)) {
              mod.editFilesPerSession.set(sessionId, new Set());
            }
            mod.editFilesPerSession.get(sessionId)!.add(file);
          }
        }

        // Session-level signals (attributed to dirs that were edited)
        if (correctionCount > 0) mod.sessionCorrections++;
        if (abandonment) mod.sessionAbandoned++;
        mod.totalCost += costUsd;
      }

      if (sessionReadDirs.has(dir) && !sessionEditDirs.has(dir)) {
        // Count reads only for dirs that weren't also edited in this session
        for (const op of toolOps) {
          if ((op.name === "Read" || op.name === "Grep" || op.name === "Glob") && op.arg &&
              truncateToDepth(normalizePath(op.arg, cwd), depth) === dir) {
            mod.reads++;
          }
        }
      }
    }

    // Count re-edit sessions per file
    for (const [file, count] of sessionEditFiles) {
      if (count >= 2 && fileMap.has(file)) {
        fileMap.get(file)!.reEditSessions++;
      }
    }
  }

  // Build output
  const modules: ModuleProfile[] = [];
  for (const [path, mod] of moduleMap) {
    if (mod.edits === 0 && mod.reads === 0) continue;

    const sessionCount = mod.sessions.size;
    // re_edit_rate: sessions where any file in this dir was edited 2+ times / total sessions
    let reEditSessions = 0;
    for (const [, files] of mod.editFilesPerSession) {
      for (const file of files) {
        // Check if this file was edited more than once across all the module's session data
        const fileEditsInDir = mod.editFiles.get(file) ?? 0;
        if (fileEditsInDir >= 2) { reEditSessions++; break; }
      }
    }

    modules.push({
      path,
      sessions_touched: sessionCount,
      total_edits: mod.edits,
      total_reads: mod.reads,
      re_edit_rate: mod.editFilesPerSession.size > 0
        ? reEditSessions / mod.editFilesPerSession.size
        : 0,
      session_correction_rate: sessionCount > 0 ? mod.sessionCorrections / sessionCount : 0,
      session_abandonment_rate: sessionCount > 0 ? mod.sessionAbandoned / sessionCount : 0,
      avg_cost_usd: mod.editFilesPerSession.size > 0
        ? mod.totalCost / mod.editFilesPerSession.size
        : 0,
    });
  }

  // Sort by sessions_touched desc, then edits desc
  modules.sort((a, b) => b.sessions_touched - a.sessions_touched || b.total_edits - a.total_edits);

  // File hotspots: top 20 by total edits
  const hotspots: FileHotspot[] = [...fileMap.entries()]
    .map(([path, f]) => ({
      path,
      total_edits: f.edits,
      sessions_count: f.sessions.size,
      re_edit_sessions: f.reEditSessions,
    }))
    .sort((a, b) => b.total_edits - a.total_edits)
    .slice(0, 20);

  return {
    period: { since: "", until: "" }, // Filled by caller
    total_sessions: sessions.length,
    total_cost_usd: totalCostAccum,
    modules,
    file_hotspots: hotspots,
  };
}

/**
 * Normalize a file path by removing the cwd prefix.
 */
function normalizePath(filePath: string, cwd?: string): string {
  let p = filePath;
  if (cwd && p.startsWith(cwd)) {
    p = p.slice(cwd.length);
    if (p.startsWith("/")) p = p.slice(1);
  }
  // Also try to strip common home-relative prefixes
  const homePrefix = "/Users/";
  if (p.startsWith(homePrefix)) {
    const parts = p.split("/");
    // Find a likely project root (after home/user/)
    if (parts.length > 3) {
      p = parts.slice(3).join("/");
    }
  }
  return p;
}

/**
 * Truncate a file path to a directory at the given depth.
 * depth=2: "src/api/routes.ts" → "src/api/"
 */
function truncateToDepth(filePath: string, depth: number): string {
  const parts = filePath.split("/");
  if (parts.length <= depth) return parts.slice(0, -1).join("/") + "/";
  return parts.slice(0, depth).join("/") + "/";
}

// ── Terminal Rendering ──────────────────────────────────────

export function renderProfile(profile: ProfileOutput): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold(`Agent Profile (${profile.total_sessions} sessions, $${profile.total_cost_usd.toFixed(2)} total)`));
  if (profile.period.since || profile.period.until) {
    lines.push(chalk.dim(`  ${profile.period.since || "..."} ~ ${profile.period.until || "now"}`));
  }
  lines.push("");

  if (profile.modules.length > 0) {
    // Header
    lines.push(chalk.dim(
      "  " + "Module".padEnd(24) +
      "Sessions".padStart(10) +
      "Edits".padStart(7) +
      "ReEdit%".padStart(9) +
      "Correct%".padStart(10) +
      "Abandon%".padStart(10) +
      "AvgCost".padStart(9)
    ));
    lines.push(chalk.dim("  " + "─".repeat(79)));

    for (const mod of profile.modules) {
      const warn = mod.session_correction_rate > 0.3 || mod.session_abandonment_rate > 0
        ? chalk.yellow(" ⚠")
        : "";
      lines.push(
        "  " +
        mod.path.padEnd(24) +
        String(mod.sessions_touched).padStart(10) +
        String(mod.total_edits).padStart(7) +
        `${(mod.re_edit_rate * 100).toFixed(0)}%`.padStart(9) +
        `${(mod.session_correction_rate * 100).toFixed(0)}%`.padStart(10) +
        `${(mod.session_abandonment_rate * 100).toFixed(0)}%`.padStart(10) +
        `$${mod.avg_cost_usd.toFixed(2)}`.padStart(9) +
        warn
      );
    }
  }

  if (profile.file_hotspots.length > 0) {
    lines.push("");
    lines.push(chalk.bold("File Hotspots:"));
    for (const f of profile.file_hotspots.slice(0, 10)) {
      const warn = f.re_edit_sessions > 0
        ? chalk.yellow(` (re-edited in ${f.re_edit_sessions}/${f.sessions_count} sessions)`)
        : "";
      lines.push(`  ${f.path.padEnd(40)} ${String(f.total_edits).padStart(3)} edits, ${f.sessions_count} sessions${warn}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
