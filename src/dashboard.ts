import chalk from "chalk";
import type { LiveMetrics } from "./types.js";
import { formatDuration, formatNum } from "./format.js";

const IDLE_THRESHOLD_MS = 30_000;

function computeActiveDurationFromLive(metrics: LiveMetrics): number {
  let idleTime = 0;
  for (const t of metrics.turns_detail) {
    if (t.inter_turn_gap_ms > IDLE_THRESHOLD_MS) {
      idleTime += t.inter_turn_gap_ms;
    }
  }
  const wall = metrics.is_running
    ? Date.now() - (metrics.started_at ? new Date(metrics.started_at).getTime() : Date.now())
    : metrics.duration_ms;
  return Math.max(0, wall - idleTime);
}

const BAR_CHARS = "█▓▒░";

function bar(count: number, max: number, width = 20): string {
  if (max === 0) return "";
  const filled = Math.round((count / max) * width);
  return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(width - filled));
}

function cacheHitRate(metrics: LiveMetrics): string {
  const total =
    metrics.total_input_tokens +
    metrics.total_cache_read_tokens +
    metrics.total_cache_creation_tokens;
  if (total === 0) return "0%";
  const rate = (metrics.total_cache_read_tokens / total) * 100;
  return rate.toFixed(0) + "%";
}

/**
 * Render the live dashboard to a string (suitable for writing to stdout).
 */
export function renderDashboard(metrics: LiveMetrics): string {
  const lines: string[] = [];
  const w = 50;
  const sep = chalk.dim("─".repeat(w));

  // Header
  const status = metrics.is_running
    ? chalk.green("● running")
    : chalk.yellow("● stopped");
  lines.push("");
  lines.push(
    chalk.bold(` Session: ${chalk.cyan(metrics.session_id.slice(0, 8))}..  ${status}`)
  );
  lines.push(` ${sep}`);

  // Timing
  const duration = metrics.is_running
    ? Date.now() - (metrics.started_at ? new Date(metrics.started_at).getTime() : Date.now())
    : metrics.duration_ms;
  const activeDur = computeActiveDurationFromLive(metrics);
  lines.push(
    ` ${chalk.dim("Duration:")}  ${formatDuration(duration)}` +
      `  ${chalk.dim("Active:")} ${formatDuration(activeDur)}` +
      `  ${chalk.dim("Model:")} ${chalk.white(metrics.model)}`
  );
  lines.push(
    ` ${chalk.dim("Turns:")}    ${metrics.turns} main + ${metrics.sidechain_turns} sidechain` +
      `    ${chalk.dim("Tools:")} ${metrics.total_tool_calls}`
  );

  // Tokens
  lines.push(` ${sep}`);
  lines.push(chalk.bold(" Tokens"));
  lines.push(
    `   ${chalk.dim("Input:")}  ${formatNum(metrics.total_input_tokens).padStart(8)}` +
      `   ${chalk.dim("Output:")} ${formatNum(metrics.total_output_tokens).padStart(8)}`
  );
  lines.push(
    `   ${chalk.dim("Cache:")}  ${formatNum(metrics.total_cache_read_tokens).padStart(8)} read` +
      `  ${chalk.dim("Hit rate:")} ${cacheHitRate(metrics)}`
  );

  // Tool breakdown
  const tools = Object.entries(metrics.tool_calls).sort(
    (a, b) => b[1].count - a[1].count
  );
  if (tools.length > 0) {
    lines.push(` ${sep}`);
    lines.push(chalk.bold(` Tools (${metrics.total_tool_calls} calls)`));
    const maxCount = tools[0]![1].count;
    for (const [name, info] of tools.slice(0, 8)) {
      const errStr =
        info.errors > 0 ? chalk.red(` (${info.errors} err)`) : "";
      lines.push(
        `   ${name.padEnd(12)} ${bar(info.count, maxCount, 15)} ${String(info.count).padStart(3)}${errStr}`
      );
    }
    if (tools.length > 8) {
      lines.push(chalk.dim(`   ... and ${tools.length - 8} more`));
    }
  }

  // Code changes
  if (metrics.lines_added > 0 || metrics.lines_removed > 0 || metrics.files_changed.size > 0) {
    lines.push(` ${sep}`);
    lines.push(chalk.bold(" Code Changes"));
    lines.push(
      `   ${chalk.green("+" + metrics.lines_added)} / ${chalk.red("-" + metrics.lines_removed)} lines` +
        `   ${metrics.files_changed.size} files`
    );
    const files = Array.from(metrics.files_changed).slice(0, 5);
    for (const f of files) {
      const short = f.split("/").slice(-2).join("/");
      lines.push(`   ${chalk.dim(short)}`);
    }
    if (metrics.files_changed.size > 5) {
      lines.push(chalk.dim(`   ... and ${metrics.files_changed.size - 5} more`));
    }
  }

  // Context
  if (metrics.compact_count > 0) {
    lines.push(` ${sep}`);
    lines.push(
      ` ${chalk.dim("Compactions:")} ${metrics.compact_count}` +
        `   ${chalk.dim("Max context:")} ${formatNum(metrics.max_context_tokens)} tokens`
    );
  }

  // Last action
  if (metrics.last_tool) {
    lines.push(` ${sep}`);
    const args = metrics.last_tool_args
      ? chalk.dim(` ${metrics.last_tool_args}`)
      : "";
    lines.push(` ${chalk.dim("Last:")} ${metrics.last_tool}${args}`);
  }

  lines.push(` ${sep}`);
  lines.push(chalk.dim(" Press Ctrl+C to stop watching"));
  lines.push("");

  return lines.join("\n");
}

/**
 * Render a final summary after session ends.
 */
export function renderSummary(metrics: LiveMetrics): string {
  const lines: string[] = [];

  const status = metrics.stop_reason === "end_turn"
    ? chalk.green("✓ Completed")
    : chalk.yellow(`⚠ ${metrics.stop_reason || "unknown"}`);

  lines.push("");
  lines.push(`${status} Session ${chalk.cyan(metrics.session_id.slice(0, 8))} (${formatDuration(metrics.duration_ms)}, active: ${formatDuration(computeActiveDurationFromLive(metrics))})`);
  lines.push("");
  lines.push(chalk.bold("Summary:"));
  lines.push(`  Turns: ${metrics.turns} main + ${metrics.sidechain_turns} sidechain | Model: ${metrics.model}`);
  lines.push(
    `  Tokens: ${formatNum(metrics.total_input_tokens)} in / ${formatNum(metrics.total_output_tokens)} out (cache hit: ${cacheHitRate(metrics)})`
  );

  const toolStr = Object.entries(metrics.tool_calls)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, info]) => `${name}(${info.count})`)
    .join(" ");
  lines.push(`  Tools: ${toolStr} = ${metrics.total_tool_calls} calls`);

  if (metrics.lines_added > 0 || metrics.lines_removed > 0) {
    lines.push(
      `  Code: ${chalk.green("+" + metrics.lines_added)} / ${chalk.red("-" + metrics.lines_removed)} lines / ${metrics.files_changed.size} files`
    );
  }

  if (metrics.compact_count > 0) {
    lines.push(`  Compactions: ${metrics.compact_count}`);
  }

  lines.push("");
  return lines.join("\n");
}
