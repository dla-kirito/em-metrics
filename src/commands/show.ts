/**
 * show command — render metrics for a single session.
 */

import chalk from "chalk";
import type { EvalSessionMetrics } from "../types.js";
import { formatDuration } from "../format.js";

export function printMetrics(m: EvalSessionMetrics, detail?: boolean): void {
  console.log("");
  console.log(
    chalk.bold(`Session ${chalk.cyan(m.session_id.slice(0, 8))}`) +
      `  ${m.model}  ${formatDuration(m.wall_duration_ms)} wall / ${formatDuration(m.active_duration_ms)} active`
  );
  console.log(chalk.dim("─".repeat(60)));
  console.log(`  Turns:    ${m.mainchain_turns} main + ${m.sidechain_turns} sidechain`);
  console.log(
    `  Tokens:   ${m.total_input_tokens} in / ${m.total_output_tokens} out`
  );
  console.log(`  Cost:     $${m.cost_usd.toFixed(4)}`);
  console.log(
    `  Cache:    ${m.total_cache_read_tokens} read / ${m.total_cache_creation_tokens} creation  (hit rate: ${(m.overall_cache_hit_rate * 100).toFixed(0)}%)`
  );
  if (m.total_cache_creation_tokens === 0 && m.total_cache_read_tokens > 0) {
    console.log(chalk.dim(`            (cache_creation=0: Coco does not report this metric, hit rate may be inflated)`));
  }
  console.log(`  Tools:    ${m.total_tool_calls} calls`);
  for (const [name, info] of Object.entries(m.tool_breakdown)) {
    const err = info.errors > 0 ? chalk.red(` (${info.errors} err)`) : "";
    console.log(`            ${name}: ${info.count}${err}`);
  }
  if (m.lines_added > 0 || m.lines_removed > 0) {
    console.log(
      `  Code:     ${chalk.green("+" + m.lines_added)} / ${chalk.red("-" + m.lines_removed)}  (${m.files_changed.length} files)`
    );
  }
  if (m.compact_count > 0) {
    console.log(`  Compact:  ${m.compact_count}`);
  }
  console.log(`  Stop:     ${m.stop_reason || "unknown"}`);

  // User interaction quality
  if (m.user_messages > 0 || m.tool_errors > 0 || m.correction_count > 0) {
    console.log(chalk.bold("  Interaction:"));
    console.log(`    User turns:  ${m.user_turns}`);
    if (m.correction_count > 0) {
      console.log(`    Corrections: ${m.correction_count} (follow-ups after end_turn)`);
    }
    if (m.tool_errors > 0) {
      console.log(`    Tool errors: ${chalk.red(String(m.tool_errors))}`);
    }
    if (m.files_re_edited > 0) {
      console.log(`    Re-edited files: ${m.files_re_edited}`);
    }
    if (m.abandonment) {
      console.log(`    ${chalk.yellow("Session abandoned (not end_turn)")}`);
    }
  }

  // Token efficiency
  console.log(chalk.bold("  Efficiency:"));
  if (m.tokens_per_loc !== null) {
    console.log(`    Tokens/LOC:      ${m.tokens_per_loc.toFixed(0)}`);
  }
  console.log(`    Tool success:    ${(m.tool_success_rate * 100).toFixed(0)}%`);
  console.log(`    Exploration:     ${(m.exploration_ratio * 100).toFixed(0)}% (Read+Grep+Glob)`);
  console.log(`    Edit precision:  ${(m.edit_precision * 100).toFixed(0)}%`);

  // Cache hit rate trend (sparkline)
  if (m.cache_hit_rate_trend.length > 1) {
    const rates = m.cache_hit_rate_trend;
    const availWidth = Math.min(process.stdout.columns || 80, 72) - 4;
    const chunkSize = rates.length > availWidth ? Math.ceil(rates.length / availWidth) : 1;
    const chunks: number[] = [];
    for (let i = 0; i < rates.length; i += chunkSize) {
      const slice = rates.slice(i, i + chunkSize);
      chunks.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }

    const tickEvery = chunks.length > 30 ? 10 : 5;
    const bar = chunks
      .map((r, i) => {
        const sep = i > 0 && i % tickEvery === 0 ? chalk.dim("┊") : "";
        if (r >= 0.8) return sep + chalk.bgGreenBright.black("▏");
        if (r >= 0.5) return sep + chalk.bgYellowBright.black("▏");
        if (r >= 0.2) return sep + chalk.bgRedBright.black("▏");
        return sep + chalk.bgBlackBright.white("▏");
      })
      .join("");

    const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    const low = Math.min(...rates);
    const drops = rates
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r < 0.5);

    console.log(chalk.bold("  Cache trend:") + chalk.dim(` ${rates.length} turns, avg ${(avgRate * 100).toFixed(0)}%, min ${(low * 100).toFixed(0)}%`));
    console.log(`    ${bar}`);
    console.log(
      chalk.dim("    ") +
        chalk.greenBright("█") + chalk.dim(" ≥80%  ") +
        chalk.yellowBright("█") + chalk.dim(" 50-80  ") +
        chalk.redBright("█") + chalk.dim(" 20-50  ") +
        chalk.blackBright("█") + chalk.dim(" <20%")
    );
    if (drops.length > 0 && drops.length <= 10) {
      const dropTurns = drops.map((d) => `#${d.i + 1}(${(d.r * 100).toFixed(0)}%)`).join(" ");
      console.log(chalk.dim(`    ⚠ cache drops: ${dropTurns}`));
    } else if (drops.length > 10) {
      console.log(chalk.dim(`    ⚠ ${drops.length} turns with cache <50%`));
    }
  }

  // Per-turn detail
  if (detail && m.turns_detail.length > 0) {
    console.log("");
    console.log(chalk.bold("  Per-turn detail:"));
    console.log(
      chalk.dim("  #   tokens(in/out)  cache%  tools                      gap")
    );
    for (const t of m.turns_detail) {
      const idx = String(t.turn_index).padStart(3);
      const tokens = `${t.input_tokens}/${t.output_tokens}`.padStart(12);
      const cache = `${(t.cache_hit_rate * 100).toFixed(0)}%`.padStart(5);
      const tools = t.tool_calls.join(",").slice(0, 26).padEnd(26);
      const gap = t.inter_turn_gap_ms > 0 ? formatDuration(t.inter_turn_gap_ms) : "-";
      const errMark = t.has_tool_error ? chalk.red(" ERR") : "";
      const scMark = t.is_sidechain ? chalk.dim(" [sc]") : "";
      console.log(`  ${idx}  ${tokens}  ${cache}  ${tools} ${gap}${errMark}${scMark}`);
    }
  }

  console.log("");
}
