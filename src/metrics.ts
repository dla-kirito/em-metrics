import type {
  AssistantEntry,
  ContentBlock,
  EvalSessionMetrics,
  LiveMetrics,
  SessionEntry,
  TurnMetrics,
} from "./types.js";
import { createEmptyLiveMetrics } from "./types.js";
import { isAssistantWithUsage } from "./parser.js";

import { computeCostUsd } from "./pricing.js";
import { med, p90 } from "./stats.js";

/** Idle gap threshold: gaps longer than this are excluded from active_duration */
const IDLE_THRESHOLD_MS = 30_000;

/**
 * Parse an MCP-prefixed tool name of the form `mcp__<server>__<tool...>`.
 * Splits on double-underscore; the tool segment may itself contain underscores.
 * Returns null for names that are not MCP-prefixed.
 */
export function parseMcpToolName(
  name: string
): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  const server = parts[1];
  if (!server) return null;
  const tool = parts.slice(2).join("__");
  return { server, tool };
}

/** Bucket a mainchain turn count into the shot histogram buckets. */
export function computeShotBucket(
  mainchainTurns: number
): "1" | "2-4" | "5-10" | "10+" {
  if (mainchainTurns <= 1) return "1";
  if (mainchainTurns <= 4) return "2-4";
  if (mainchainTurns <= 10) return "5-10";
  return "10+";
}

/**
 * Normalize a file path to an extension key for distribution reporting.
 * Handles: Makefile/Dockerfile → lowercase basename; foo.d.ts → ".d.ts";
 * foo.test.ts → ".ts"; .gitignore → ".gitignore"; no-extension → "(none)".
 */
export function normalizeFileExt(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const lower = base.toLowerCase();

  // Well-known extension-less filenames
  if (lower === "makefile" || lower === "dockerfile" || lower === "readme") {
    return lower;
  }

  // Dotfile (e.g. .gitignore, .env) — no further extension
  if (lower.startsWith(".") && !lower.slice(1).includes(".")) {
    return lower;
  }

  // Compound .d.ts
  if (lower.endsWith(".d.ts")) return ".d.ts";

  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return "(none)";
  return lower.slice(dot);
}

/**
 * Count cache breaks on the main chain: transitions where a turn with
 * cache_read_tokens>0 is followed by one with cache_read_tokens===0.
 * Skips the first turn (cold start) and excludes sidechain turns.
 */
export function countCacheBreaks(turns: TurnMetrics[]): number {
  const main = turns.filter((t) => !t.is_sidechain);
  let breaks = 0;
  for (let i = 1; i < main.length; i++) {
    if (main[i - 1].cache_read_tokens > 0 && main[i].cache_read_tokens === 0) {
      breaks++;
    }
  }
  return breaks;
}

/**
 * Detect whether a user tool_result represents a user rejection (not a runtime error).
 * Claude Code writes a recognizable sentinel text when a tool is denied.
 */
export function isRejectionResult(content: unknown): boolean {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === "object" && "text" in b) {
        text += String((b as { text: unknown }).text ?? "");
      }
    }
  }
  return /user doesn't want to proceed|tool use was rejected/i.test(text);
}

/**
 * Process a single entry and update live metrics in-place.
 */
export function processEntry(entry: SessionEntry, metrics: LiveMetrics): void {
  // Track timestamps
  if (entry.timestamp && !metrics.started_at) {
    metrics.started_at = entry.timestamp;
  }
  if (entry.timestamp) {
    const start = new Date(metrics.started_at!).getTime();
    const now = new Date(entry.timestamp).getTime();
    if (!isNaN(start) && !isNaN(now)) {
      metrics.duration_ms = now - start;
    }
  }

  // Session ID from permission-mode entry
  if (entry.type === "permission-mode" && "sessionId" in entry) {
    metrics.session_id = (entry as any).sessionId;
    if ("permissionMode" in entry) {
      metrics.permission_mode = String((entry as any).permissionMode ?? "");
    }
  }

  // Count user messages here; assistant messages are counted below under
  // the isNewMessage guard to match dedup semantics for streaming.
  if (entry.type === "user") {
    metrics.message_count++;
  }

  // Assistant messages
  if (isAssistantWithUsage(entry)) {
    const msg = entry.message;
    const msgId = msg.id;

    // Dedup: for streaming, the same message.id appears multiple times.
    const isNewMessage = !msgId || !metrics.seen_message_ids.has(msgId);
    if (msgId) {
      metrics.seen_message_ids.add(msgId);
    }

    // Model
    if (msg.model) {
      metrics.model = msg.model;
    }

    if (isNewMessage) {
      const usage = msg.usage!;
      metrics.total_input_tokens += usage.input_tokens;
      metrics.total_output_tokens += usage.output_tokens;
      metrics.total_cache_read_tokens += usage.cache_read_input_tokens ?? 0;
      metrics.total_cache_creation_tokens +=
        usage.cache_creation_input_tokens ?? 0;

      metrics.message_count++;

      // Accumulate server-side tool usage (e.g. web_search_requests)
      if (usage.server_tool_use) {
        for (const [k, v] of Object.entries(usage.server_tool_use)) {
          if (typeof v === "number") {
            metrics.server_tool_usage[k] = (metrics.server_tool_usage[k] ?? 0) + v;
          }
        }
      }

      // Per-model usage (for multi-model sessions)
      const modelKey = msg.model ?? "unknown";
      if (!metrics.model_usage[modelKey]) {
        metrics.model_usage[modelKey] = { calls: 0, input_tokens: 0, output_tokens: 0 };
      }
      metrics.model_usage[modelKey].calls++;
      metrics.model_usage[modelKey].input_tokens += usage.input_tokens;
      metrics.model_usage[modelKey].output_tokens += usage.output_tokens;

      // Track max context size (input + cache_read + cache_creation all occupy the context window)
      const contextTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (contextTokens > metrics.max_context_tokens) {
        metrics.max_context_tokens = contextTokens;
      }

      // Count turns
      const isSidechain = !!entry.isSidechain;
      if (!isSidechain) {
        metrics.turns++;
      } else {
        metrics.sidechain_turns++;
      }

      // Stop reason
      if (msg.stop_reason) {
        metrics.stop_reason = msg.stop_reason;
        metrics.last_stop_reason = msg.stop_reason;
      }

      // Collect tool names for this turn; accumulate output/thinking char counts
      const turnTools: string[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          turnTools.push(block.name);
        } else if (block.type === "text" && "text" in block) {
          metrics.output_chars_total += (block.text ?? "").length;
        } else if (block.type === "thinking" && "thinking" in block) {
          metrics.thinking_chars_total += (block.thinking ?? "").length;
        }
      }

      // Compute inter-turn gap
      let interTurnGap = 0;
      if (entry.timestamp && metrics.last_turn_timestamp) {
        const prev = new Date(metrics.last_turn_timestamp).getTime();
        const curr = new Date(entry.timestamp).getTime();
        if (!isNaN(prev) && !isNaN(curr)) {
          interTurnGap = curr - prev;
        }
      }

      // Per-turn cache hit rate
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheCreate = usage.cache_creation_input_tokens ?? 0;
      const totalInput = usage.input_tokens + cacheRead + cacheCreate;
      const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

      // Record per-turn metrics
      const turnMetric: TurnMetrics = {
        turn_index: metrics.turns_detail.length,
        timestamp: entry.timestamp ?? "",
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: cacheRead,
        cache_creation_tokens: cacheCreate,
        cache_hit_rate: cacheHitRate,
        tool_calls: turnTools,
        has_tool_error: false,
        stop_reason: msg.stop_reason ?? "",
        is_sidechain: isSidechain,
        inter_turn_gap_ms: interTurnGap,
      };
      metrics.turns_detail.push(turnMetric);

      if (entry.timestamp) {
        metrics.last_turn_timestamp = entry.timestamp;
      }

      // Process content blocks for tool usage (inside isNewMessage to prevent double-counting in streaming)
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const toolName = block.name;
          if (!metrics.tool_calls[toolName]) {
            metrics.tool_calls[toolName] = { count: 0, errors: 0 };
          }
          metrics.tool_calls[toolName].count++;
          metrics.total_tool_calls++;
          metrics.last_tool = toolName;

          // MCP accounting
          const mcp = parseMcpToolName(toolName);
          if (mcp) {
            metrics.mcp_tool_calls++;
            metrics.mcp_servers_used.add(mcp.server);
          }

          // Sample tool_use input size (UTF-16 chars via JSON.stringify)
          try {
            metrics.tool_use_chars_samples.push(JSON.stringify(block.input ?? {}).length);
          } catch {
            // circular refs etc — skip sampling
          }

          const input = block.input as Record<string, unknown>;
          if (input.file_path) {
            metrics.last_tool_args = String(input.file_path);
          } else if (input.command) {
            const cmd = String(input.command);
            metrics.last_tool_args = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
          } else if (input.pattern) {
            metrics.last_tool_args = String(input.pattern);
          } else {
            metrics.last_tool_args = null;
          }

          if (
            (toolName === "Edit" || toolName === "Write") &&
            input.file_path
          ) {
            metrics.files_changed.add(String(input.file_path));
          }

          if (toolName === "Edit" && input.new_string !== undefined && input.old_string !== undefined) {
            const oldLines = String(input.old_string).split("\n").length;
            const newLines = String(input.new_string).split("\n").length;
            if (newLines > oldLines) {
              metrics.lines_added += newLines - oldLines;
            } else {
              metrics.lines_removed += oldLines - newLines;
            }
          }

          if (toolName === "Write" && input.content) {
            metrics.lines_added += String(input.content).split("\n").length;
          }

          // Heuristic: estimate lines from Bash file-writing commands
          if (toolName === "Bash" && input.command) {
            const cmd = String(input.command);
            const bashLines = estimateBashLines(cmd);
            metrics.lines_added += bashLines;
          }

          // Track Edit rework (same file edited multiple times)
          if (toolName === "Edit" && input.file_path) {
            const fp = String(input.file_path);
            metrics.edit_file_counts.set(fp, (metrics.edit_file_counts.get(fp) ?? 0) + 1);
          }
        }
      }
    }
  }

  // Track tool errors and user interaction from user messages
  if (entry.type === "user" && "message" in entry) {
    const msg = (entry as any).message;

    metrics.user_messages++;

    // Determine if this is a real user text message (not just tool_result)
    let hasRealUserText = false;
    if (typeof msg?.content === "string" && msg.content.trim()) {
      hasRealUserText = true;
    } else if (Array.isArray(msg?.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text" && (block as any).text?.trim()) {
          hasRealUserText = true;
          break;
        }
      }
    }

    if (hasRealUserText) {
      metrics.user_turns++;
      // Real correction: user sends a new message after agent said end_turn
      // (i.e., agent thought it was done, but user followed up with more instructions)
      if (metrics.last_entry_was_assistant && metrics.last_stop_reason === "end_turn") {
        metrics.correction_count++;
      }
    }

    if (msg?.content && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "tool_result") {
          // Sample tool_result content size
          const rc = block.content;
          let chars = 0;
          if (typeof rc === "string") {
            chars = rc.length;
          } else if (Array.isArray(rc)) {
            for (const sub of rc) {
              if (sub && typeof sub === "object" && "text" in sub) {
                chars += String((sub as { text: unknown }).text ?? "").length;
              }
            }
          }
          metrics.tool_result_chars_samples.push(chars);

          if (block.is_error) {
            metrics.tool_errors++;
            if (metrics.last_tool && metrics.tool_calls[metrics.last_tool]) {
              metrics.tool_calls[metrics.last_tool].errors++;
            }
            // Mark last turn as having an error
            if (metrics.turns_detail.length > 0) {
              metrics.turns_detail[metrics.turns_detail.length - 1].has_tool_error = true;
            }
            // Distinguish user rejections from runtime errors
            if (isRejectionResult(rc)) {
              metrics.tool_rejections++;
            }
          }
        }
      }
    }
  }

  // Track last entry type for correction detection
  metrics.last_entry_was_assistant = entry.type === "assistant";

  // Detect compaction
  if (entry.type === "system" && "message" in entry) {
    const text = JSON.stringify((entry as any).message);
    if (text.includes("compact") || text.includes("summariz")) {
      metrics.compact_count++;
    }
  }
}

/**
 * Deduplicate assistant entries: keep only the last entry per message.id.
 */
export function deduplicateEntries(entries: SessionEntry[]): SessionEntry[] {
  const lastIndex = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "assistant" && "message" in entry) {
      const id = (entry as AssistantEntry).message?.id;
      if (id) lastIndex.set(id, i);
    }
  }

  const seen = new Set<string>();
  const result: SessionEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "assistant" && "message" in entry) {
      const id = (entry as AssistantEntry).message?.id;
      if (id) {
        if (lastIndex.get(id) === i && !seen.has(id)) {
          seen.add(id);
          result.push(entry);
        }
      } else {
        result.push(entry);
      }
    } else {
      result.push(entry);
    }
  }
  return result;
}

/**
 * Compute active duration: wall time minus idle gaps > threshold.
 */
function computeActiveDuration(turns: TurnMetrics[], wallMs: number): number {
  let idleTime = 0;
  for (const t of turns) {
    if (t.inter_turn_gap_ms > IDLE_THRESHOLD_MS) {
      idleTime += t.inter_turn_gap_ms;
    }
  }
  return Math.max(0, wallMs - idleTime);
}

/**
 * Extract full session metrics from all entries.
 */
export function extractMetrics(
  entries: SessionEntry[],
  sessionId: string
): EvalSessionMetrics {
  const live = createEmptyLiveMetrics(sessionId);
  const deduped = deduplicateEntries(entries);

  for (const entry of deduped) {
    processEntry(entry, live);
  }

  return liveToFinal(live);
}

/**
 * Convert live metrics to final EvalSessionMetrics.
 */
export function liveToFinal(live: LiveMetrics): EvalSessionMetrics {
  const cacheTotal =
    live.total_input_tokens +
    live.total_cache_read_tokens +
    live.total_cache_creation_tokens;
  const overallCacheHitRate =
    cacheTotal > 0 ? live.total_cache_read_tokens / cacheTotal : 0;

  const activeDuration = computeActiveDuration(live.turns_detail, live.duration_ms);

  return {
    session_id: live.session_id,
    model: live.model,
    started_at: live.started_at ?? "",
    ended_at: live.started_at
      ? new Date(
          new Date(live.started_at).getTime() + live.duration_ms
        ).toISOString()
      : "",
    wall_duration_ms: live.duration_ms,
    active_duration_ms: activeDuration,
    total_input_tokens: live.total_input_tokens,
    total_output_tokens: live.total_output_tokens,
    total_cache_read_tokens: live.total_cache_read_tokens,
    total_cache_creation_tokens: live.total_cache_creation_tokens,
    overall_cache_hit_rate: overallCacheHitRate,
    api_calls: live.turns,
    api_retries: 0,
    total_tool_calls: live.total_tool_calls,
    tool_breakdown: { ...live.tool_calls },
    mcp_tool_calls: live.mcp_tool_calls,
    mcp_servers_used: Array.from(live.mcp_servers_used).sort(),
    lines_added: live.lines_added,
    lines_removed: live.lines_removed,
    files_changed: Array.from(live.files_changed),
    compact_count: live.compact_count,
    max_context_tokens: live.max_context_tokens,
    stop_reason: live.stop_reason,
    turns_detail: live.turns_detail,
    cache_hit_rate_trend: live.turns_detail.map((t) => t.cache_hit_rate),
    sidechain_turns: live.sidechain_turns,
    mainchain_turns: live.turns,
    one_shot: live.turns === 1 && live.stop_reason === "end_turn",
    shot_bucket: computeShotBucket(live.turns),
    cost_usd: computeCostUsd(
      live.model,
      live.total_input_tokens,
      live.total_output_tokens,
      live.total_cache_read_tokens,
      live.total_cache_creation_tokens
    ),
    user_messages: live.user_messages,
    user_turns: live.user_turns,
    tool_rejections: live.tool_rejections,
    tool_errors: live.tool_errors,
    correction_count: live.correction_count,
    files_re_edited: Array.from(live.edit_file_counts.values()).filter((c) => c > 1).length,
    abandonment: live.stop_reason !== "end_turn" && live.stop_reason !== "" && live.stop_reason !== "tool_use",
    tokens_per_loc: computeTokensPerLoc(live),
    tool_success_rate: live.total_tool_calls > 0 ? 1 - live.tool_errors / live.total_tool_calls : 1,
    exploration_ratio: computeExplorationRatio(live),
    edit_precision: computeEditPrecision(live),

    // P1: output structure
    message_count: live.message_count,
    output_chars_total: live.output_chars_total,
    thinking_chars_total: live.thinking_chars_total,
    tool_use_chars_p50: Math.round(med(live.tool_use_chars_samples)),
    tool_use_chars_p90: Math.round(p90(live.tool_use_chars_samples)),
    tool_result_chars_p50: Math.round(med(live.tool_result_chars_samples)),
    tool_result_chars_p90: Math.round(p90(live.tool_result_chars_samples)),

    // P1: distributions
    file_ext_distribution: computeFileExtDistribution(live.files_changed),
    server_tool_usage: { ...live.server_tool_usage },
    model_usage: { ...live.model_usage },

    // P1: events & context
    cache_break_count: countCacheBreaks(live.turns_detail),
    permission_mode: live.permission_mode,
  };
}

function computeFileExtDistribution(files: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const ext = normalizeFileExt(f);
    out[ext] = (out[ext] ?? 0) + 1;
  }
  return out;
}

function computeTokensPerLoc(live: LiveMetrics): number | null {
  const loc = live.lines_added + live.lines_removed;
  if (loc === 0) return null;
  return live.total_output_tokens / loc;
}

function computeExplorationRatio(live: LiveMetrics): number {
  if (live.total_tool_calls === 0) return 0;
  const explorationTools = ["Read", "Grep", "Glob"];
  let count = 0;
  for (const name of explorationTools) {
    count += live.tool_calls[name]?.count ?? 0;
  }
  return count / live.total_tool_calls;
}

function computeEditPrecision(live: LiveMetrics): number {
  const totalEdits = live.edit_file_counts.size > 0
    ? Array.from(live.edit_file_counts.values()).reduce((a, b) => a + b, 0)
    : 0;
  if (totalEdits === 0) return 1;
  return live.edit_file_counts.size / totalEdits;
}

/**
 * Best-effort estimate of lines written by Bash commands.
 * Detects heredocs (cat/tee <<), echo/printf redirects, and patch/sed -i.
 * Returns 0 when no file-writing pattern is recognized.
 */
function estimateBashLines(cmd: string): number {
  let lines = 0;

  // Heredoc: cat > file <<'EOF' ... EOF  or  tee file <<EOF ... EOF
  const heredocRe = /<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\1/g;
  let m: RegExpExecArray | null;
  while ((m = heredocRe.exec(cmd)) !== null) {
    lines += m[2].split("\n").length;
  }
  if (lines > 0) return lines;

  // Multi-line echo/printf redirect: echo "..." > file
  const echoRe = /(?:echo|printf)\s+(?:-[eEn]\s+)?(['"])([\s\S]*?)\1\s*>>?\s*\S+/g;
  while ((m = echoRe.exec(cmd)) !== null) {
    lines += m[2].split("\n").length;
  }
  if (lines > 0) return lines;

  // patch / git apply — count lines starting with +/- (rough)
  if (/\b(?:patch|git\s+apply)\b/.test(cmd)) {
    const diffLines = cmd.split("\n").filter((l) => /^[+-][^+-]/.test(l));
    lines += diffLines.length;
  }

  return lines;
}
