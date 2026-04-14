import chalk from "chalk";
import type {
  TraceOutput,
  TraceStep,
  PatternsOutput,
  PatternEntry,
  SessionEntry,
  ContentBlock,
} from "./types.js";
import { isAssistantWithUsage } from "./parser.js";

interface PatternDetector {
  id: string;
  name: string;
  description: string;
  category: "anti" | "effective";
  detect: (steps: TraceStep[], sessionId: string) => boolean;
  sequence: string[];
}

const PATTERN_DETECTORS: PatternDetector[] = [
  // ── Anti-patterns ──
  {
    id: "edit-test-fail-loop",
    name: "Edit-test-fail loop",
    description: "Edit → test → fail 循环 2+ 次，agent 在试错而非理解问题",
    category: "anti",
    sequence: ["Edit", "Bash", "ERR", "Edit", "Bash", "ERR"],
    detect(steps) {
      let loopCount = 0;
      for (let i = 0; i < steps.length - 4; i++) {
        if (
          steps[i].type === "tool_call" && steps[i].tool_name === "Edit" &&
          steps[i + 1]?.type === "tool_result" &&
          steps[i + 2]?.type === "tool_call" && steps[i + 2].tool_name === "Bash" &&
          steps[i + 3]?.type === "tool_result" && steps[i + 3].is_error
        ) {
          loopCount++;
          if (loopCount >= 2) return true;
        } else if (steps[i].type === "user_text") {
          loopCount = 0; // Reset on user intervention
        }
      }
      return false;
    },
  },
  {
    id: "exploration-drift",
    name: "Exploration drift",
    description: "连续 3+ 次探索跨多个目录，agent 不确定在哪找信息",
    category: "anti",
    sequence: ["Read", "Read", "Read", "(different dirs)"],
    detect(steps) {
      const explorationTools = new Set(["Read", "Grep", "Glob"]);
      let runLen = 0;
      const dirs = new Set<string>();

      for (const s of steps) {
        if (s.type === "tool_call" && explorationTools.has(s.tool_name ?? "")) {
          runLen++;
          const arg = s.tool_arg ?? "";
          const dir = arg.includes("/") ? arg.split("/").slice(0, -1).join("/") : "";
          if (dir) dirs.add(dir);
        } else {
          if (runLen >= 3 && dirs.size >= 3) return true;
          runLen = 0;
          dirs.clear();
        }
      }
      return runLen >= 3 && dirs.size >= 3;
    },
  },
  {
    id: "file-churn",
    name: "File churn",
    description: "同一文件被编辑 3+ 次，可能是反复修改试错",
    category: "anti",
    sequence: ["Edit(X)", "...", "Edit(X)", "...", "Edit(X)"],
    detect(steps) {
      const editCounts = new Map<string, number>();
      for (const s of steps) {
        if (s.type === "tool_call" && s.tool_name === "Edit" && s.tool_arg) {
          editCounts.set(s.tool_arg, (editCounts.get(s.tool_arg) ?? 0) + 1);
        }
      }
      for (const count of editCounts.values()) {
        if (count >= 3) return true;
      }
      return false;
    },
  },
  {
    id: "tool-error-chain",
    name: "Tool error chain",
    description: "连续 2+ 个工具调用报错",
    category: "anti",
    sequence: ["tool ERR", "tool ERR"],
    detect(steps) {
      let errorRun = 0;
      for (const s of steps) {
        if (s.type === "tool_result" && s.is_error) {
          errorRun++;
          if (errorRun >= 2) return true;
        } else if (s.type === "tool_result") {
          errorRun = 0;
        }
      }
      return false;
    },
  },

  // ── Effective patterns ──
  {
    id: "read-then-edit",
    name: "Read before edit",
    description: "先读文件再编辑同一文件，编辑无报错 — 谨慎的好习惯",
    category: "effective",
    sequence: ["Read(X)", "Edit(X)", "OK"],
    detect(steps) {
      for (let i = 0; i < steps.length - 3; i++) {
        if (
          steps[i].type === "tool_call" && steps[i].tool_name === "Read" && steps[i].tool_arg &&
          steps[i + 1]?.type === "tool_result" && !steps[i + 1].is_error
        ) {
          // Look ahead for Edit of same file
          for (let j = i + 2; j < Math.min(i + 6, steps.length); j++) {
            if (
              steps[j].type === "tool_call" && steps[j].tool_name === "Edit" &&
              steps[j].tool_arg === steps[i].tool_arg
            ) {
              // Check result
              if (j + 1 < steps.length && steps[j + 1].type === "tool_result" && !steps[j + 1].is_error) {
                return true;
              }
            }
          }
        }
      }
      return false;
    },
  },
  {
    id: "one-shot-complete",
    name: "One-shot completion",
    description: "单个用户指令直达完成，无纠正 — 高效执行",
    category: "effective",
    sequence: ["User", "..tools..", "end_turn"],
    detect(steps) {
      let userTextCount = 0;
      for (const s of steps) {
        if (s.type === "user_text") userTextCount++;
      }
      return userTextCount === 1;
    },
  },
  {
    id: "parallel-tools",
    name: "Parallel tool calls",
    description: "单次回复中并行调用多个工具 — 高效利用",
    category: "effective",
    sequence: ["tool_A + tool_B + tool_C (same turn)"],
    detect(steps) {
      // Detect: 3+ consecutive tool_call steps with the same timestamp
      for (let i = 0; i < steps.length - 2; i++) {
        if (
          steps[i].type === "tool_call" &&
          steps[i + 1]?.type === "tool_call" &&
          steps[i + 2]?.type === "tool_call" &&
          steps[i].timestamp === steps[i + 1].timestamp &&
          steps[i].timestamp === steps[i + 2].timestamp
        ) {
          return true;
        }
      }
      return false;
    },
  },
];

interface FindPatternsOpts {
  minOccurrences?: number;
}

/**
 * Lightweight step extraction for pattern detection only.
 * Skips deduplication, cost computation, signal detection, and text extraction
 * that full extractTrace() does. Only extracts fields used by pattern detectors:
 * type, tool_name, tool_arg, is_error, timestamp.
 */
export function extractLightSteps(entries: SessionEntry[]): TraceStep[] {
  const steps: TraceStep[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const ts = entry.timestamp ?? "";

    if (isAssistantWithUsage(entry)) {
      const msg = entry.message;
      const msgId = msg.id;
      if (msgId && seenIds.has(msgId)) continue;
      if (msgId) seenIds.add(msgId);

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          steps.push({
            index: steps.length,
            type: "tool_call",
            timestamp: ts,
            is_sidechain: !!(entry as any).isSidechain,
            tool_name: block.name,
            tool_arg: input.file_path ? String(input.file_path) : (input.command ? String(input.command) : ""),
            tool_id: block.id,
          });
        }
      }
    } else if (entry.type === "user" && "message" in entry) {
      const msg = (entry as any).message;
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === "tool_result") {
            steps.push({
              index: steps.length,
              type: "tool_result",
              timestamp: ts,
              is_sidechain: !!(entry as any).isSidechain,
              tool_use_id: block.tool_use_id,
              is_error: !!block.is_error,
            });
          } else if (block.type === "text" && (block as any).text?.trim()) {
            steps.push({
              index: steps.length,
              type: "user_text",
              timestamp: ts,
              is_sidechain: false,
            });
          }
        }
      } else if (typeof msg?.content === "string" && msg.content.trim()) {
        steps.push({
          index: steps.length,
          type: "user_text",
          timestamp: ts,
          is_sidechain: false,
        });
      }
    }
  }
  return steps;
}

interface SessionInput {
  sessionId: string;
  entries: SessionEntry[];
}

/**
 * Find behavioral patterns from raw session entries (lightweight path).
 */
export function findPatternsFromEntries(
  sessions: SessionInput[],
  opts?: FindPatternsOpts
): PatternsOutput {
  const minOcc = opts?.minOccurrences ?? 3;

  const antiResults = new Map<string, { detector: PatternDetector; sessions: string[] }>();
  const effectiveResults = new Map<string, { detector: PatternDetector; sessions: string[] }>();

  for (const det of PATTERN_DETECTORS) {
    const target = det.category === "anti" ? antiResults : effectiveResults;
    target.set(det.id, { detector: det, sessions: [] });
  }

  for (const session of sessions) {
    const steps = extractLightSteps(session.entries);
    for (const det of PATTERN_DETECTORS) {
      const target = det.category === "anti" ? antiResults : effectiveResults;
      if (det.detect(steps, session.sessionId)) {
        target.get(det.id)!.sessions.push(session.sessionId);
      }
    }
  }

  const totalSessions = sessions.length;
  const toEntries = (map: typeof antiResults): PatternEntry[] => {
    const entries: PatternEntry[] = [];
    for (const [, { detector, sessions: matchedSessions }] of map) {
      if (matchedSessions.length < Math.min(minOcc, totalSessions)) continue;
      entries.push({
        id: detector.id,
        name: detector.name,
        description: detector.description,
        occurrences: matchedSessions.length,
        affected_pct: totalSessions > 0 ? matchedSessions.length / totalSessions : 0,
        example_sessions: matchedSessions.slice(0, 3),
        typical_sequence: detector.sequence,
      });
    }
    return entries.sort((a, b) => b.occurrences - a.occurrences);
  };

  return {
    period: { since: "", until: "" },
    total_sessions: totalSessions,
    anti_patterns: toEntries(antiResults),
    effective_patterns: toEntries(effectiveResults),
  };
}

/**
 * Find behavioral patterns across multiple session traces.
 */
export function findPatterns(
  traces: TraceOutput[],
  opts?: FindPatternsOpts
): PatternsOutput {
  const minOcc = opts?.minOccurrences ?? 3;

  const antiResults = new Map<string, { detector: PatternDetector; sessions: string[] }>();
  const effectiveResults = new Map<string, { detector: PatternDetector; sessions: string[] }>();

  for (const det of PATTERN_DETECTORS) {
    const target = det.category === "anti" ? antiResults : effectiveResults;
    target.set(det.id, { detector: det, sessions: [] });
  }

  for (const trace of traces) {
    for (const det of PATTERN_DETECTORS) {
      const target = det.category === "anti" ? antiResults : effectiveResults;
      if (det.detect(trace.steps, trace.session_id)) {
        target.get(det.id)!.sessions.push(trace.session_id);
      }
    }
  }

  const toEntries = (map: typeof antiResults): PatternEntry[] => {
    const entries: PatternEntry[] = [];
    for (const [, { detector, sessions }] of map) {
      if (sessions.length < Math.min(minOcc, traces.length)) continue;
      entries.push({
        id: detector.id,
        name: detector.name,
        description: detector.description,
        occurrences: sessions.length,
        affected_pct: traces.length > 0 ? sessions.length / traces.length : 0,
        example_sessions: sessions.slice(0, 3),
        typical_sequence: detector.sequence,
      });
    }
    return entries.sort((a, b) => b.occurrences - a.occurrences);
  };

  return {
    period: { since: "", until: "" },
    total_sessions: traces.length,
    anti_patterns: toEntries(antiResults),
    effective_patterns: toEntries(effectiveResults),
  };
}

// ── Terminal Rendering ──────────────────────────────────────

export function renderPatterns(patterns: PatternsOutput): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold(`Behavioral Patterns (${patterns.total_sessions} sessions)`));
  if (patterns.period.since || patterns.period.until) {
    lines.push(chalk.dim(`  ${patterns.period.since || "..."} ~ ${patterns.period.until || "now"}`));
  }
  lines.push("");

  if (patterns.anti_patterns.length > 0) {
    lines.push(chalk.red.bold("  Anti-patterns:"));
    for (const p of patterns.anti_patterns) {
      const pct = `${(p.affected_pct * 100).toFixed(0)}%`;
      lines.push(
        `  ${chalk.red("✗")} ${p.name.padEnd(24)} ${String(p.occurrences).padStart(3)} sessions (${pct})`
      );
      lines.push(chalk.dim(`    ${p.description}`));
    }
    lines.push("");
  }

  if (patterns.effective_patterns.length > 0) {
    lines.push(chalk.green.bold("  Effective patterns:"));
    for (const p of patterns.effective_patterns) {
      const pct = `${(p.affected_pct * 100).toFixed(0)}%`;
      lines.push(
        `  ${chalk.green("✓")} ${p.name.padEnd(24)} ${String(p.occurrences).padStart(3)} sessions (${pct})`
      );
      lines.push(chalk.dim(`    ${p.description}`));
    }
    lines.push("");
  }

  if (patterns.anti_patterns.length === 0 && patterns.effective_patterns.length === 0) {
    lines.push(chalk.dim("  No patterns detected (need more sessions or lower --min-occurrences)."));
    lines.push("");
  }

  return lines.join("\n");
}
