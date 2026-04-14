/**
 * analyze command — render aggregated metrics across multiple sessions.
 */

import chalk from "chalk";
import type { EvalSessionMetrics } from "../types.js";
import { avg, med, p90, sum } from "../stats.js";
import { col } from "../format.js";

export function printAnalysis(allMetrics: EvalSessionMetrics[]): void {
  console.log(chalk.bold(`\nFound ${allMetrics.length} sessions\n`));

  // ── Data arrays ──
  const turns = allMetrics.map((m) => m.api_calls);
  const mainTurns = allMetrics.map((m) => m.mainchain_turns);
  const sidechainTurns = allMetrics.map((m) => m.sidechain_turns);
  const toolCalls = allMetrics.map((m) => m.total_tool_calls);
  const inputTokens = allMetrics.map((m) => m.total_input_tokens);
  const outputTokens = allMetrics.map((m) => m.total_output_tokens);
  const cacheReadTokens = allMetrics.map((m) => m.total_cache_read_tokens);
  const cacheCreateTokens = allMetrics.map((m) => m.total_cache_creation_tokens);
  const durations = allMetrics.map((m) => m.wall_duration_ms);
  const activeDurations = allMetrics.map((m) => m.active_duration_ms);
  const cacheRates = allMetrics.map((m) => m.overall_cache_hit_rate);
  const costs = allMetrics.map((m) => m.cost_usd);
  const corrections = allMetrics.map((m) => m.correction_count);
  const userTurns = allMetrics.map((m) => m.user_turns);
  const toolErrors = allMetrics.map((m) => m.tool_errors);
  const reEdited = allMetrics.map((m) => m.files_re_edited);
  const toolSuccessRates = allMetrics.map((m) => m.tool_success_rate);
  const explorationRatios = allMetrics.map((m) => m.exploration_ratio);
  const editPrecisions = allMetrics.map((m) => m.edit_precision);
  const tokensPerLoc = allMetrics.filter((m) => m.tokens_per_loc !== null).map((m) => m.tokens_per_loc!);

  // ── Overview ──
  const hdr = `                  ${col("avg")}${col("median")}${col("p90")}`;
  console.log(chalk.dim(hdr));
  console.log(`  Turns:          ${col(avg(turns).toFixed(1))}${col(med(turns).toFixed(1))}${col(p90(turns).toFixed(0))}`);
  console.log(chalk.dim(`    main:         ${col(avg(mainTurns).toFixed(1))}${col(med(mainTurns).toFixed(1))}${col(p90(mainTurns).toFixed(0))}`));
  if (sum(sidechainTurns) > 0) {
    console.log(chalk.dim(`    sidechain:    ${col(avg(sidechainTurns).toFixed(1))}${col(med(sidechainTurns).toFixed(1))}${col(p90(sidechainTurns).toFixed(0))}`));
  }
  console.log(`  Tool calls:     ${col(avg(toolCalls).toFixed(1))}${col(med(toolCalls).toFixed(1))}${col(p90(toolCalls).toFixed(0))}`);
  console.log(`  Tokens in:      ${col(String(Math.round(avg(inputTokens))))}${col(String(Math.round(med(inputTokens))))}${col(String(Math.round(p90(inputTokens))))}`);
  console.log(`  Tokens out:     ${col(String(Math.round(avg(outputTokens))))}${col(String(Math.round(med(outputTokens))))}${col(String(Math.round(p90(outputTokens))))}`);
  console.log(`  Cost ($):       ${col(avg(costs).toFixed(4))}${col(med(costs).toFixed(4))}${col(p90(costs).toFixed(4))}   Total: $${sum(costs).toFixed(2)}`);
  console.log(`  Duration (s):   ${col((avg(durations) / 1000).toFixed(1))}${col((med(durations) / 1000).toFixed(1))}${col((p90(durations) / 1000).toFixed(1))}   wall`);
  console.log(`  Active (s):     ${col((avg(activeDurations) / 1000).toFixed(1))}${col((med(activeDurations) / 1000).toFixed(1))}${col((p90(activeDurations) / 1000).toFixed(1))}`);

  // ── Cache ──
  console.log(`  Cache hit rate: ${col((avg(cacheRates) * 100).toFixed(0) + "%")}${col((med(cacheRates) * 100).toFixed(0) + "%")}${col((p90(cacheRates) * 100).toFixed(0) + "%")}`);
  console.log(chalk.dim(`    read tokens:  ${col(String(Math.round(avg(cacheReadTokens))))}${col(String(Math.round(med(cacheReadTokens))))}      total: ${sum(cacheReadTokens)}`));
  if (sum(cacheCreateTokens) > 0) {
    console.log(chalk.dim(`    create tokens:${col(String(Math.round(avg(cacheCreateTokens))))}${col(String(Math.round(med(cacheCreateTokens))))}      total: ${sum(cacheCreateTokens)}`));
  }

  // ── One-shot & stop reason ──
  const oneShotSessions = allMetrics.filter(
    (m) => m.mainchain_turns === 1 && m.stop_reason === "end_turn"
  ).length;
  const oneShotRate = allMetrics.length > 0
    ? (oneShotSessions / allMetrics.length * 100).toFixed(0)
    : "0";
  console.log(`  One-shot rate:  ${oneShotRate}% (${oneShotSessions}/${allMetrics.length})`);

  // Stop reason distribution
  const stopReasons: Record<string, number> = {};
  for (const m of allMetrics) {
    const reason = m.stop_reason || "unknown";
    stopReasons[reason] = (stopReasons[reason] ?? 0) + 1;
  }
  const reasonParts = Object.entries(stopReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}: ${n}`);
  console.log(`  Stop reasons:   ${reasonParts.join("  ")}`);

  // ── Code changes ──
  const totalLinesAdded = sum(allMetrics.map((m) => m.lines_added));
  const totalLinesRemoved = sum(allMetrics.map((m) => m.lines_removed));
  const totalFilesChanged = new Set(allMetrics.flatMap((m) => m.files_changed)).size;
  const totalCompacts = sum(allMetrics.map((m) => m.compact_count));
  if (totalLinesAdded > 0 || totalLinesRemoved > 0) {
    console.log(`  Code changes:   ${chalk.green("+" + totalLinesAdded)} / ${chalk.red("-" + totalLinesRemoved)}  (${totalFilesChanged} files)`);
  }
  if (totalCompacts > 0) {
    console.log(`  Compactions:    ${totalCompacts} total  (avg ${avg(allMetrics.map((m) => m.compact_count)).toFixed(1)}/session)`);
  }

  // ── Interaction quality ──
  console.log(chalk.bold("\n  Interaction:"));
  console.log(`    User turns:      ${col(String(sum(userTurns)), 6)} total  avg ${avg(userTurns).toFixed(1)}  med ${med(userTurns).toFixed(0)}`);
  console.log(`    Corrections:     ${col(String(sum(corrections)), 6)} total  avg ${avg(corrections).toFixed(1)}  med ${med(corrections).toFixed(0)}  p90 ${p90(corrections)}`);
  console.log(`    Tool errors:     ${col(String(sum(toolErrors)), 6)} total  avg ${avg(toolErrors).toFixed(1)}  med ${med(toolErrors).toFixed(0)}  p90 ${p90(toolErrors)}`);
  console.log(`    Re-edited files: ${col(String(sum(reEdited)), 6)} total  avg ${avg(reEdited).toFixed(1)}  med ${med(reEdited).toFixed(0)}`);
  const abandonedCount = allMetrics.filter((m) => m.abandonment).length;
  console.log(`    Abandoned:       ${abandonedCount}/${allMetrics.length} sessions`);

  // ── Efficiency ──
  console.log(chalk.bold("\n  Efficiency:"));
  if (tokensPerLoc.length > 0) {
    console.log(`    Tokens/LOC:      avg ${col(String(avg(tokensPerLoc).toFixed(0)), 6)}  med ${col(String(med(tokensPerLoc).toFixed(0)), 6)}  p90 ${p90(tokensPerLoc).toFixed(0)}`);
  }
  console.log(`    Tool success:    avg ${col((avg(toolSuccessRates) * 100).toFixed(0) + "%", 5)}  med ${(med(toolSuccessRates) * 100).toFixed(0)}%`);
  console.log(`    Exploration:     avg ${col((avg(explorationRatios) * 100).toFixed(0) + "%", 5)}  med ${(med(explorationRatios) * 100).toFixed(0)}%  (Read+Grep+Glob)`);
  console.log(`    Edit precision:  avg ${col((avg(editPrecisions) * 100).toFixed(0) + "%", 5)}  med ${(med(editPrecisions) * 100).toFixed(0)}%`);

  // ── Tool distribution ──
  const toolTotals: Record<string, { count: number; errors: number }> = {};
  for (const m of allMetrics) {
    for (const [tool, info] of Object.entries(m.tool_breakdown)) {
      if (!toolTotals[tool]) toolTotals[tool] = { count: 0, errors: 0 };
      toolTotals[tool].count += info.count;
      toolTotals[tool].errors += info.errors;
    }
  }
  const sorted = Object.entries(toolTotals).sort((a, b) => b[1].count - a[1].count);
  const total = sorted.reduce((s, [, v]) => s + v.count, 0);

  console.log(chalk.bold("\n  Tool distribution:"));
  for (const [name, info] of sorted) {
    const pct = ((info.count / total) * 100).toFixed(0);
    const err = info.errors > 0 ? chalk.red(` (${info.errors} err)`) : "";
    console.log(`    ${name.padEnd(16)} ${String(info.count).padStart(5)}  (${pct.padStart(2)}%)${err}`);
  }
  console.log("");
}
