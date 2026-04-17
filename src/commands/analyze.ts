/**
 * analyze command — render aggregated metrics across multiple sessions.
 */

import chalk from "chalk";
import type { EvalSessionMetrics } from "../types.js";
import { avg, med, p90, sum } from "../stats.js";
import { col, fmtInt } from "../format.js";

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
  console.log(`  Tokens in:      ${col(fmtInt(avg(inputTokens)))}${col(fmtInt(med(inputTokens)))}${col(fmtInt(p90(inputTokens)))}`);
  console.log(`  Tokens out:     ${col(fmtInt(avg(outputTokens)))}${col(fmtInt(med(outputTokens)))}${col(fmtInt(p90(outputTokens)))}`);
  console.log(`  Cost ($):       ${col(avg(costs).toFixed(4))}${col(med(costs).toFixed(4))}${col(p90(costs).toFixed(4))}   Total: $${sum(costs).toFixed(2)}`);
  console.log(`  Duration (s):   ${col((avg(durations) / 1000).toFixed(1))}${col((med(durations) / 1000).toFixed(1))}${col((p90(durations) / 1000).toFixed(1))}   wall`);
  console.log(`  Active (s):     ${col((avg(activeDurations) / 1000).toFixed(1))}${col((med(activeDurations) / 1000).toFixed(1))}${col((p90(activeDurations) / 1000).toFixed(1))}`);

  // ── Cache ──
  console.log(`  Cache hit rate: ${col((avg(cacheRates) * 100).toFixed(0) + "%")}${col((med(cacheRates) * 100).toFixed(0) + "%")}${col((p90(cacheRates) * 100).toFixed(0) + "%")}`);
  console.log(chalk.dim(`    read tokens:  ${col(fmtInt(avg(cacheReadTokens)))}${col(fmtInt(med(cacheReadTokens)))}      total: ${fmtInt(sum(cacheReadTokens))}`));
  if (sum(cacheCreateTokens) > 0) {
    console.log(chalk.dim(`    create tokens:${col(fmtInt(avg(cacheCreateTokens)))}${col(fmtInt(med(cacheCreateTokens)))}      total: ${fmtInt(sum(cacheCreateTokens))}`));
  }

  // ── One-shot & stop reason ──
  const oneShotSessions = allMetrics.filter((m) => m.one_shot).length;
  const oneShotRate = allMetrics.length > 0
    ? (oneShotSessions / allMetrics.length * 100).toFixed(0)
    : "0";
  console.log(`  One-shot rate:  ${oneShotRate}% (${oneShotSessions}/${allMetrics.length})`);

  // Shot distribution (aligned with monitoring doc buckets).
  // The "1" bucket is split into one-shot vs stopped (turns=1 but stop_reason
  // !== end_turn — typically ESC/budget interruption) so the histogram stays
  // consistent with the "One-shot rate" line above.
  const bucketCounts: Record<string, number> = {
    "1 (one-shot)": 0,
    "1 (stopped)": 0,
    "2-4": 0,
    "5-10": 0,
    "10+": 0,
  };
  for (const m of allMetrics) {
    if (m.shot_bucket === "1") {
      if (m.one_shot) bucketCounts["1 (one-shot)"]++;
      else bucketCounts["1 (stopped)"]++;
    } else {
      bucketCounts[m.shot_bucket] = (bucketCounts[m.shot_bucket] ?? 0) + 1;
    }
  }
  const rowOrder = ["1 (one-shot)", "1 (stopped)", "2-4", "5-10", "10+"];
  const visibleRows = rowOrder.filter(
    (k) => bucketCounts[k] > 0 || k !== "1 (stopped)"
  );
  const maxBucket = Math.max(...Object.values(bucketCounts), 1);
  const labelW = Math.max(...visibleRows.map((k) => k.length));
  const barWidth = 20;
  console.log(`  Shot dist:`);
  for (const k of visibleRows) {
    const n = bucketCounts[k] ?? 0;
    const pct = allMetrics.length > 0 ? ((n / allMetrics.length) * 100).toFixed(0) : "0";
    const bar = "█".repeat(Math.round((n / maxBucket) * barWidth));
    console.log(`    ${k.padEnd(labelW)} ${chalk.cyan(bar.padEnd(barWidth))} ${String(n).padStart(4)} (${pct.padStart(2)}%)`);
  }

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

  // ── Interaction quality ──
  console.log(chalk.bold("\n  Interaction:"));
  console.log(`    User turns:      ${col(String(sum(userTurns)), 6)} total  avg ${avg(userTurns).toFixed(1)}  med ${med(userTurns).toFixed(0)}`);
  console.log(`    Corrections:     ${col(String(sum(corrections)), 6)} total  avg ${avg(corrections).toFixed(1)}  med ${med(corrections).toFixed(0)}  p90 ${p90(corrections)}`);
  console.log(`    Tool errors:     ${col(String(sum(toolErrors)), 6)} total  avg ${avg(toolErrors).toFixed(1)}  med ${med(toolErrors).toFixed(0)}  p90 ${p90(toolErrors)}`);
  const totalRejections = sum(allMetrics.map((m) => m.tool_rejections));
  if (totalRejections > 0) {
    console.log(`    Tool rejections: ${col(String(totalRejections), 6)} total  (user denied tool use)`);
  }
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
  const nameW = Math.min(Math.max(16, ...sorted.map(([n]) => n.length)), 40);
  for (const [name, info] of sorted) {
    const pct = ((info.count / total) * 100).toFixed(0);
    const err = info.errors > 0 ? chalk.red(` (${info.errors} err)`) : "";
    const displayName = name.length > nameW ? name.slice(0, nameW - 1) + "…" : name.padEnd(nameW);
    console.log(`    ${displayName} ${String(info.count).padStart(5)}  (${pct.padStart(2)}%)${err}`);
  }

  // ── MCP usage ──
  const totalMcp = sum(allMetrics.map((m) => m.mcp_tool_calls));
  if (totalMcp > 0) {
    const serverCounts: Record<string, number> = {};
    for (const m of allMetrics) {
      for (const [toolName, info] of Object.entries(m.tool_breakdown)) {
        if (toolName.startsWith("mcp__")) {
          const parts = toolName.split("__");
          if (parts.length >= 3 && parts[1]) {
            serverCounts[parts[1]] = (serverCounts[parts[1]] ?? 0) + info.count;
          }
        }
      }
    }
    const sessionsWithMcp = allMetrics.filter((m) => m.mcp_tool_calls > 0).length;
    console.log(chalk.bold("\n  MCP usage:"));
    console.log(`    Total MCP calls: ${totalMcp}  (${sessionsWithMcp}/${allMetrics.length} sessions)`);
    const serverSorted = Object.entries(serverCounts).sort((a, b) => b[1] - a[1]);
    for (const [server, count] of serverSorted) {
      console.log(`    ${server.padEnd(16)} ${String(count).padStart(5)}`);
    }
  }
  // ── Output structure ──
  const outputChars = allMetrics.map((m) => m.output_chars_total);
  const thinkingChars = allMetrics.map((m) => m.thinking_chars_total);
  const toolUseP50 = allMetrics.map((m) => m.tool_use_chars_p50);
  const toolUseP90 = allMetrics.map((m) => m.tool_use_chars_p90);
  const toolResP50 = allMetrics.map((m) => m.tool_result_chars_p50);
  const toolResP90 = allMetrics.map((m) => m.tool_result_chars_p90);
  console.log(chalk.bold("\n  Output structure (chars):"));
  console.log(`    Text output:     avg ${col(String(Math.round(avg(outputChars))), 7)}  med ${col(String(Math.round(med(outputChars))), 7)}`);
  if (sum(thinkingChars) > 0) {
    console.log(`    Thinking:        avg ${col(String(Math.round(avg(thinkingChars))), 7)}  med ${col(String(Math.round(med(thinkingChars))), 7)}`);
  }
  console.log(`    Tool input:      p50 ${col(String(Math.round(avg(toolUseP50))), 7)}  p90 ${col(String(Math.round(avg(toolUseP90))), 7)}  (avg across sessions)`);
  console.log(`    Tool result:     p50 ${col(String(Math.round(avg(toolResP50))), 7)}  p90 ${col(String(Math.round(avg(toolResP90))), 7)}`);

  // ── Events (session-level occurrences) ──
  const totalCacheBreaks = sum(allMetrics.map((m) => m.cache_break_count));
  const serverToolTotals: Record<string, number> = {};
  for (const m of allMetrics) {
    for (const [k, v] of Object.entries(m.server_tool_usage)) {
      serverToolTotals[k] = (serverToolTotals[k] ?? 0) + v;
    }
  }
  const nonZeroServerTools = Object.entries(serverToolTotals).filter(([, v]) => v > 0);
  const hasEvents = totalCompacts > 0 || totalCacheBreaks > 0 || nonZeroServerTools.length > 0;
  if (hasEvents) {
    console.log(chalk.bold("\n  Events:"));
    if (totalCompacts > 0) {
      console.log(`    Compactions:     ${totalCompacts} total  (avg ${avg(allMetrics.map((m) => m.compact_count)).toFixed(1)}/session)`);
    }
    if (totalCacheBreaks > 0) {
      const sessionsWithBreak = allMetrics.filter((m) => m.cache_break_count > 0).length;
      console.log(`    Cache breaks:    ${totalCacheBreaks} total  (${sessionsWithBreak}/${allMetrics.length} sessions affected)`);
    }
    if (nonZeroServerTools.length > 0) {
      const parts = nonZeroServerTools.map(([k, v]) => `${k}: ${fmtInt(v)}`);
      console.log(`    Server tools:    ${parts.join("  ")}`);
    }
  }

  // ── File extension distribution ──
  const extTotals: Record<string, number> = {};
  for (const m of allMetrics) {
    for (const [ext, n] of Object.entries(m.file_ext_distribution)) {
      extTotals[ext] = (extTotals[ext] ?? 0) + n;
    }
  }
  const extEntries = Object.entries(extTotals).sort((a, b) => b[1] - a[1]);
  if (extEntries.length > 0) {
    console.log(chalk.bold("\n  File types edited:"));
    for (const [ext, n] of extEntries.slice(0, 8)) {
      console.log(`    ${ext.padEnd(12)} ${String(n).padStart(5)}`);
    }
  }

  // ── Model usage (only meaningful when multi-model across sessions) ──
  const modelAgg: Record<string, { calls: number; input_tokens: number; output_tokens: number }> = {};
  for (const m of allMetrics) {
    for (const [model, u] of Object.entries(m.model_usage)) {
      if (!modelAgg[model]) modelAgg[model] = { calls: 0, input_tokens: 0, output_tokens: 0 };
      modelAgg[model].calls += u.calls;
      modelAgg[model].input_tokens += u.input_tokens;
      modelAgg[model].output_tokens += u.output_tokens;
    }
  }
  if (Object.keys(modelAgg).length > 1) {
    console.log(chalk.bold("\n  Model usage:"));
    const modelSorted = Object.entries(modelAgg).sort((a, b) => b[1].calls - a[1].calls);
    for (const [model, u] of modelSorted) {
      console.log(`    ${model.padEnd(28)} ${String(u.calls).padStart(5)} calls  in=${fmtInt(u.input_tokens)}  out=${fmtInt(u.output_tokens)}`);
    }
  }

  console.log("");
}
