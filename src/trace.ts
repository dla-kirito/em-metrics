import chalk from "chalk";
import type {
  SessionEntry,
  AssistantEntry,
  ContentBlock,
  TraceOutput,
  TraceStep,
  TraceSignal,
} from "./types.js";
import { deduplicateEntries } from "./metrics.js";
import { isAssistantWithUsage } from "./parser.js";
import { computeCostUsd } from "./pricing.js";
import { formatDuration } from "./format.js";

interface TraceOpts {
  verbose?: boolean;
}

/**
 * Extract a structured behavioral trace from session entries.
 */
export function extractTrace(
  entries: SessionEntry[],
  sessionId: string,
  opts?: TraceOpts
): TraceOutput {
  const verbose = opts?.verbose ?? false;
  const deduped = deduplicateEntries(entries);

  const steps: TraceStep[] = [];
  let userPrompt = "";
  let model = "unknown";
  let startedAt = "";
  let endedAt = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let lastStopReason = "";

  for (const entry of deduped) {
    const ts = entry.timestamp ?? "";
    if (ts && !startedAt) startedAt = ts;
    if (ts) endedAt = ts;

    const isSidechain = !!(entry as any).isSidechain;

    // User entries
    if (entry.type === "user" && "message" in entry) {
      const msg = (entry as any).message;

      // Extract user text
      if (typeof msg?.content === "string" && msg.content.trim()) {
        if (!userPrompt) userPrompt = msg.content;
        steps.push({
          index: steps.length,
          type: "user_text",
          timestamp: ts,
          is_sidechain: isSidechain,
          text: msg.content.length > 500
            ? msg.content.slice(0, 500) + "..."
            : msg.content,
        });
      } else if (Array.isArray(msg?.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === "text" && (block as any).text?.trim()) {
            const text = (block as any).text as string;
            if (!userPrompt) userPrompt = text;
            steps.push({
              index: steps.length,
              type: "user_text",
              timestamp: ts,
              is_sidechain: isSidechain,
              text: text.length > 500 ? text.slice(0, 500) + "..." : text,
            });
          } else if (block.type === "tool_result") {
            const step: TraceStep = {
              index: steps.length,
              type: "tool_result",
              timestamp: ts,
              is_sidechain: isSidechain,
              tool_use_id: block.tool_use_id,
              is_error: !!block.is_error,
            };
            if (verbose && block.content) {
              const content = typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
              step.result_preview = content.length > 200
                ? content.slice(0, 200) + "..."
                : content;
            }
            steps.push(step);
          }
        }
      }
    }

    // Assistant entries
    if (isAssistantWithUsage(entry)) {
      const msg = entry.message;
      if (msg.model) model = msg.model;

      const usage = msg.usage!;
      totalInputTokens += usage.input_tokens;
      totalOutputTokens += usage.output_tokens;
      totalCacheRead += usage.cache_read_input_tokens ?? 0;
      totalCacheCreate += usage.cache_creation_input_tokens ?? 0;

      if (msg.stop_reason) lastStopReason = msg.stop_reason;

      // Compute cache hit rate for this turn
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheCreate = usage.cache_creation_input_tokens ?? 0;
      const totalInput = usage.input_tokens + cacheRead + cacheCreate;
      const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

      let isFirstToolInTurn = true;

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          const step: TraceStep = {
            index: steps.length,
            type: "tool_call",
            timestamp: ts,
            is_sidechain: isSidechain,
            tool_name: block.name,
            tool_arg: extractToolArg(input),
            tool_id: block.id,
          };
          if (isFirstToolInTurn) {
            step.output_tokens = usage.output_tokens;
            step.cache_hit_rate = cacheHitRate;
            isFirstToolInTurn = false;
          }
          steps.push(step);
        } else if (block.type === "text" && verbose) {
          const text = (block as any).text as string;
          if (text?.trim()) {
            steps.push({
              index: steps.length,
              type: "assistant_text",
              timestamp: ts,
              is_sidechain: isSidechain,
              assistant_text: text.length > 300
                ? text.slice(0, 300) + "..."
                : text,
            });
          }
        } else if (block.type === "thinking" && verbose) {
          const thinking = (block as any).thinking as string;
          if (thinking?.trim()) {
            steps.push({
              index: steps.length,
              type: "thinking",
              timestamp: ts,
              is_sidechain: isSidechain,
              assistant_text: thinking.length > 300
                ? thinking.slice(0, 300) + "..."
                : thinking,
            });
          }
        }
      }

      // If no tool_use in this turn (pure text response), attach token info to a synthetic marker
      if (isFirstToolInTurn && msg.stop_reason === "end_turn" && !verbose) {
        // No step to attach to — skip; the terminal renderer handles end_turn separately
      }
    }
  }

  // Re-index after all steps collected
  for (let i = 0; i < steps.length; i++) {
    steps[i].index = i;
  }

  const wallMs = startedAt && endedAt
    ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
    : 0;

  const signals = detectSignals(steps);

  return {
    session_id: sessionId,
    model,
    started_at: startedAt,
    wall_duration_ms: Math.max(0, wallMs),
    cost_usd: computeCostUsd(model, totalInputTokens, totalOutputTokens, totalCacheRead, totalCacheCreate),
    user_prompt: userPrompt,
    total_steps: steps.length,
    steps,
    signals,
  };
}

/**
 * Extract the most informative single argument from a tool_use input.
 */
function extractToolArg(input: Record<string, unknown>): string {
  if (input.file_path) {
    // Shorten to last 2-3 path segments
    const fp = String(input.file_path);
    const parts = fp.split("/");
    return parts.length > 3 ? parts.slice(-3).join("/") : fp;
  }
  if (input.command) {
    const cmd = String(input.command);
    return cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
  }
  if (input.pattern) return String(input.pattern);
  if (input.query) {
    const q = String(input.query);
    return q.length > 50 ? q.slice(0, 50) + "..." : q;
  }
  if (input.description) {
    const d = String(input.description);
    return d.length > 50 ? d.slice(0, 50) + "..." : d;
  }
  if (input.prompt) {
    const p = String(input.prompt);
    return p.length > 50 ? p.slice(0, 50) + "..." : p;
  }
  return "";
}

// ── Signal Detection ────────────────────────────────────────

/**
 * Detect behavioral signals from trace steps.
 */
export function detectSignals(steps: TraceStep[]): TraceSignal[] {
  const signals: TraceSignal[] = [];

  detectExplorationDrift(steps, signals);
  detectEditRetryLoop(steps, signals);
  detectUserCorrection(steps, signals);
  detectToolErrorChain(steps, signals);
  detectFileReEdit(steps, signals);
  detectCacheDrop(steps, signals);

  return signals;
}

function detectExplorationDrift(steps: TraceStep[], signals: TraceSignal[]): void {
  const explorationTools = new Set(["Read", "Grep", "Glob"]);
  let runStart = -1;
  const dirs: Set<string> = new Set();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "tool_call" && explorationTools.has(s.tool_name ?? "")) {
      if (runStart === -1) runStart = i;
      // Extract directory from tool_arg
      const arg = s.tool_arg ?? "";
      const dir = arg.includes("/") ? arg.split("/").slice(0, -1).join("/") : "";
      if (dir) dirs.add(dir);
    } else {
      if (runStart !== -1 && i - runStart >= 3 && dirs.size >= 3) {
        signals.push({
          type: "exploration_drift",
          step_range: [runStart, i - 1],
          description: `连续 ${i - runStart} 次探索，跨 ${dirs.size} 个目录`,
        });
      }
      runStart = -1;
      dirs.clear();
    }
  }
  // Check trailing run
  if (runStart !== -1 && steps.length - runStart >= 3 && dirs.size >= 3) {
    signals.push({
      type: "exploration_drift",
      step_range: [runStart, steps.length - 1],
      description: `连续 ${steps.length - runStart} 次探索，跨 ${dirs.size} 个目录`,
    });
  }
}

function detectEditRetryLoop(steps: TraceStep[], signals: TraceSignal[]): void {
  // Look for: Edit(file) → tool_result(error) → ... → Edit(same file) repeated
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type !== "tool_call" || s.tool_name !== "Edit") continue;
    const file = s.tool_arg ?? "";
    if (!file) continue;

    let retries = 0;
    let loopEnd = i;
    let j = i + 1;

    while (j < steps.length) {
      const next = steps[j];
      // Look for error result
      if (next.type === "tool_result" && next.is_error) {
        // Then look ahead for another Edit of same file
        for (let k = j + 1; k < steps.length && k <= j + 5; k++) {
          if (steps[k].type === "tool_call" && steps[k].tool_name === "Edit" && steps[k].tool_arg === file) {
            retries++;
            loopEnd = k;
            j = k + 1;
            break;
          }
          if (steps[k].type === "tool_call" && steps[k].tool_name === "Edit" && steps[k].tool_arg !== file) {
            break; // Different file, stop looking
          }
        }
        if (j <= loopEnd) break; // Didn't find re-edit
        continue;
      }
      // If we hit another Edit of same file after non-error result, also count
      if (next.type === "tool_result" && !next.is_error) {
        // Check if a test follows and fails
        break;
      }
      j++;
      if (j > i + 20) break; // Safety limit
    }

    if (retries >= 2) {
      signals.push({
        type: "edit_retry_loop",
        step_range: [i, loopEnd],
        description: `${file.split("/").pop()} 编辑重试 ${retries} 次`,
      });
    }
  }
}

function detectUserCorrection(steps: TraceStep[], signals: TraceSignal[]): void {
  // Find: a tool_call with stop_reason end_turn implicit (last tool_call before user_text
  // where the assistant turn had end_turn)
  // Simpler approach: find user_text that follows a sequence without any tool_call
  // (meaning the assistant gave a final answer / end_turn)
  // We can detect this by checking for gaps: if a user_text appears and the previous
  // non-result step was also a user_text, that's a correction.

  // Actually, we track: find user_text steps that are NOT the first user_text
  let userTextCount = 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === "user_text") {
      userTextCount++;
      if (userTextCount > 1) {
        // Check if there were tool_calls between this and previous user_text
        // (if no tool_calls, it's likely a follow-up, but we count all follow-ups)
        signals.push({
          type: "user_correction",
          step_range: [i, i],
          description: "用户追加指令",
        });
      }
    }
  }
}

function detectToolErrorChain(steps: TraceStep[], signals: TraceSignal[]): void {
  let runStart = -1;
  let count = 0;

  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === "tool_result" && steps[i].is_error) {
      if (runStart === -1) runStart = i;
      count++;
    } else if (steps[i].type === "tool_result") {
      if (count >= 2) {
        signals.push({
          type: "tool_error_chain",
          step_range: [runStart, i - 1],
          description: `连续 ${count} 个工具错误`,
        });
      }
      runStart = -1;
      count = 0;
    }
  }
  if (count >= 2) {
    signals.push({
      type: "tool_error_chain",
      step_range: [runStart, steps.length - 1],
      description: `连续 ${count} 个工具错误`,
    });
  }
}

function detectFileReEdit(steps: TraceStep[], signals: TraceSignal[]): void {
  const editCounts = new Map<string, number[]>();
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === "tool_call" && steps[i].tool_name === "Edit" && steps[i].tool_arg) {
      const file = steps[i].tool_arg!;
      if (!editCounts.has(file)) editCounts.set(file, []);
      editCounts.get(file)!.push(i);
    }
  }
  for (const [file, indices] of editCounts) {
    if (indices.length >= 3) {
      signals.push({
        type: "file_re_edit",
        step_range: [indices[0], indices[indices.length - 1]],
        description: `${file.split("/").pop()} 被编辑 ${indices.length} 次`,
      });
    }
  }
}

function detectCacheDrop(steps: TraceStep[], signals: TraceSignal[]): void {
  let prevRate: number | null = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === "tool_call" && s.cache_hit_rate !== undefined) {
      if (prevRate !== null && prevRate - s.cache_hit_rate > 0.4) {
        signals.push({
          type: "cache_drop",
          step_range: [i, i],
          description: `缓存命中率从 ${(prevRate * 100).toFixed(0)}% 降到 ${(s.cache_hit_rate * 100).toFixed(0)}%`,
        });
      }
      prevRate = s.cache_hit_rate;
    }
  }
}

// ── Terminal Rendering ──────────────────────────────────────

/**
 * Render trace to terminal output string.
 */
export function renderTrace(trace: TraceOutput): string {
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push(
    chalk.bold(`Session ${chalk.cyan(trace.session_id.slice(0, 8))}...`) +
      ` (${formatDuration(trace.wall_duration_ms)}, $${trace.cost_usd.toFixed(4)}, ${trace.model})`
  );
  lines.push("");

  // Build signal index by step
  const signalsByStep = new Map<number, TraceSignal[]>();
  for (const sig of trace.signals) {
    const key = sig.step_range[0];
    if (!signalsByStep.has(key)) signalsByStep.set(key, []);
    signalsByStep.get(key)!.push(sig);
  }

  // Build tool_result index: tool_use_id → is_error
  const resultByToolId = new Map<string, boolean>();
  for (const step of trace.steps) {
    if (step.type === "tool_result" && step.tool_use_id) {
      resultByToolId.set(step.tool_use_id, !!step.is_error);
    }
  }

  // Render steps — in compact mode, merge tool_result into tool_call line
  let stepNum = 0;
  for (const step of trace.steps) {
    const sc = step.is_sidechain ? chalk.dim(" [sc]") : "";

    // Skip tool_result in compact mode (already merged into tool_call)
    if (step.type === "tool_result" && !step.result_preview) continue;

    stepNum++;
    const idx = String(stepNum).padStart(3);

    let line = "";
    switch (step.type) {
      case "user_text":
        line = `${idx}  ${chalk.blue("User")}: "${truncate(step.text ?? "", 70)}"`;
        break;
      case "tool_call": {
        const arg = step.tool_arg ? `(${truncate(step.tool_arg, 40)})` : "";
        // Look up result for this tool_call
        let resultMark = "";
        if (step.tool_id && resultByToolId.has(step.tool_id)) {
          resultMark = resultByToolId.get(step.tool_id)
            ? " " + chalk.red("ERR")
            : " " + chalk.green("OK");
        }
        const tokInfo = step.output_tokens
          ? chalk.dim(` [${step.output_tokens} tok]`)
          : "";
        line = `${idx}  ${chalk.dim("→")} ${chalk.yellow(step.tool_name ?? "?")}${arg}${resultMark}${tokInfo}`;
        break;
      }
      case "tool_result": {
        // Only shown in verbose mode (when result_preview exists)
        const status = step.is_error ? chalk.red("ERR") : chalk.green("OK");
        line = `${idx}  ${chalk.dim("  ←")} ${status}`;
        if (step.result_preview) {
          line += chalk.dim(` ${truncate(step.result_preview, 60)}`);
        }
        break;
      }
      case "assistant_text":
        line = `${idx}  ${chalk.dim("Agent")}: "${truncate(step.assistant_text ?? "", 60)}"`;
        break;
      case "thinking":
        line = `${idx}  ${chalk.dim("Think")}: "${truncate(step.assistant_text ?? "", 60)}"`;
        break;
    }

    // Append signal markers
    const sigs = signalsByStep.get(step.index);
    if (sigs) {
      for (const sig of sigs) {
        line += chalk.yellow(` ⚠ ${sig.type.replace(/_/g, " ")}`);
      }
    }

    lines.push(line + sc);
  }

  // Signals summary
  if (trace.signals.length > 0) {
    lines.push("");
    lines.push(chalk.bold(`Signals (${trace.signals.length}):`));
    for (const sig of trace.signals) {
      const range = sig.step_range[0] === sig.step_range[1]
        ? `#${sig.step_range[0] + 1}`
        : `#${sig.step_range[0] + 1}-#${sig.step_range[1] + 1}`;
      lines.push(
        `  ${chalk.yellow("⚠")} ${sig.type.padEnd(20)} ${range.padEnd(10)} ${sig.description}`
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\n/g, " ");
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}
