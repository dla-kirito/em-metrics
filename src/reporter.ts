import chalk from "chalk";
import type { EvalResult } from "./types.js";
import { formatDuration, formatNum } from "./format.js";

/**
 * Print detailed result for a single eval task.
 */
export function printEvalResult(r: EvalResult): void {
  const k = r.trials.length;
  console.log("");
  console.log(
    chalk.bold(`Task: ${chalk.cyan(r.task_id)}`) +
      `  (${k} trial${k > 1 ? "s" : ""}, ${r.model})`
  );
  console.log(chalk.dim("─".repeat(55)));

  // Pass rate
  const passCount = r.trials.filter((t) => t.passed).length;
  const pctColor = r.pass_rate >= 0.8 ? chalk.green : r.pass_rate >= 0.5 ? chalk.yellow : chalk.red;
  console.log(
    `  Pass rate:  ${pctColor(`${(r.pass_rate * 100).toFixed(0)}%`)} (${passCount}/${k})`
  );

  if (k > 1) {
    console.log(
      `  pass@${k}:    ${(r.pass_at_k * 100).toFixed(1)}%` +
        `    pass^${k}: ${(r.pass_pow_k * 100).toFixed(1)}%`
    );
    if (r.flakiness > 0.3) {
      console.log(
        `  Flakiness:  ${chalk.yellow(r.flakiness.toFixed(2))} ${r.flakiness > 0.7 ? chalk.red("(highly flaky)") : chalk.yellow("(flaky)")}`
      );
    }
  }

  // Avg metrics
  console.log(
    `  Avg:        ${r.avg_turns.toFixed(1)} turns, ` +
      `${formatNum(r.avg_tokens)} tokens, ` +
      `${formatDuration(r.avg_duration_ms)}, ` +
      `$${r.avg_cost_usd.toFixed(4)}`
  );

  // Per-trial grader breakdown
  if (r.trials.length > 0 && r.trials[0].grader_results.length > 0) {
    console.log(chalk.bold("  Graders:"));
    const graderNames = r.trials[0].grader_results.map((g) => g.name);
    for (const name of graderNames) {
      const marks = r.trials.map((t) => {
        const g = t.grader_results.find((gr) => gr.name === name);
        if (!g) return chalk.dim("?");
        if (g.type === "llm") {
          const color = g.passed ? chalk.green : chalk.red;
          return color(g.score.toFixed(1));
        }
        return g.passed ? chalk.green("\u2713") : chalk.red("\u2717");
      });
      console.log(`    ${name.padEnd(16)} ${marks.join(" ")}`);
    }
  }

  // Errors
  const errors = r.trials.filter((t) => t.error);
  if (errors.length > 0) {
    console.log(chalk.yellow(`  Errors: ${errors.length}/${k} trials had errors`));
  }

  console.log("");
}

/**
 * Print a summary table for multiple eval results.
 */
export function printEvalSummary(results: EvalResult[]): void {
  if (results.length === 0) return;

  console.log("");
  console.log(chalk.bold(`Eval Summary (${results.length} tasks)`));
  console.log(chalk.dim("─".repeat(70)));

  // Header
  console.log(
    chalk.dim(
      "  " +
        "Task".padEnd(20) +
        "Pass%".padStart(7) +
        "pass@k".padStart(8) +
        "Score".padStart(7) +
        "Turns".padStart(7) +
        "Tokens".padStart(8) +
        "Cost".padStart(8) +
        "Time".padStart(8)
    )
  );

  for (const r of results) {
    const k = r.trials.length;
    const passColor =
      r.pass_rate >= 0.8 ? chalk.green : r.pass_rate >= 0.5 ? chalk.yellow : chalk.red;

    const line =
      "  " +
      r.task_id.slice(0, 19).padEnd(20) +
      passColor(`${(r.pass_rate * 100).toFixed(0)}%`.padStart(7)) +
      `${(r.pass_at_k * 100).toFixed(0)}%`.padStart(8) +
      r.avg_score.toFixed(2).padStart(7) +
      r.avg_turns.toFixed(1).padStart(7) +
      formatNum(r.avg_tokens).padStart(8) +
      formatCost(r.avg_cost_usd).padStart(8) +
      formatDuration(r.avg_duration_ms).padStart(8);

    console.log(line);
  }

  // Overall
  console.log(chalk.dim("─".repeat(70)));
  const overallPass =
    results.reduce((s, r) => s + r.pass_rate, 0) / results.length;
  const overallScore =
    results.reduce((s, r) => s + r.avg_score, 0) / results.length;
  console.log(
    "  " +
      chalk.bold("Overall".padEnd(20)) +
      chalk.bold(`${(overallPass * 100).toFixed(0)}%`.padStart(7)) +
      "".padStart(8) +
      chalk.bold(overallScore.toFixed(2).padStart(7))
  );
  console.log("");

  // Capability matrix if data available
  printCapabilityMatrix(results);

  // Flakiness warnings
  const flakyTasks = results.filter((r) => r.flakiness > 0.3);
  if (flakyTasks.length > 0) {
    console.log(chalk.yellow.bold(`Flaky tasks (${flakyTasks.length}):`));
    for (const r of flakyTasks.sort((a, b) => b.flakiness - a.flakiness)) {
      const label = r.flakiness > 0.7 ? chalk.red("HIGH") : chalk.yellow("MED");
      console.log(
        `  ${label} ${r.task_id.padEnd(20)} flakiness=${r.flakiness.toFixed(2)}  pass=${(r.pass_rate * 100).toFixed(0)}%`
      );
    }
    console.log("");
  }
}

/**
 * Compare two sets of eval results (e.g., different models).
 */
export function printComparison(
  a: EvalResult[],
  b: EvalResult[],
  labelA: string,
  labelB: string
): void {
  console.log("");
  console.log(chalk.bold(`Comparison: ${chalk.cyan(labelA)} vs ${chalk.magenta(labelB)}`));
  console.log(chalk.dim("─".repeat(75)));

  // Header
  console.log(
    chalk.dim(
      "  " +
        "Task".padEnd(18) +
        `${labelA}`.padStart(8) +
        `${labelB}`.padStart(8) +
        "Delta".padStart(8) +
        `Turns(${labelA.charAt(0)})`.padStart(9) +
        `Turns(${labelB.charAt(0)})`.padStart(9) +
        `Tok(${labelA.charAt(0)})`.padStart(8) +
        `Tok(${labelB.charAt(0)})`.padStart(8)
    )
  );

  // Build lookup for B results
  const bMap = new Map(b.map((r) => [r.task_id, r]));

  for (const ra of a) {
    const rb = bMap.get(ra.task_id);
    if (!rb) continue;

    const deltaPass = rb.pass_rate - ra.pass_rate;
    const deltaStr =
      deltaPass > 0
        ? chalk.green(`+${(deltaPass * 100).toFixed(0)}%`)
        : deltaPass < 0
          ? chalk.red(`${(deltaPass * 100).toFixed(0)}%`)
          : chalk.dim("0%");

    console.log(
      "  " +
        ra.task_id.slice(0, 17).padEnd(18) +
        `${(ra.pass_rate * 100).toFixed(0)}%`.padStart(8) +
        `${(rb.pass_rate * 100).toFixed(0)}%`.padStart(8) +
        deltaStr.padStart(8) +
        ra.avg_turns.toFixed(1).padStart(9) +
        rb.avg_turns.toFixed(1).padStart(9) +
        formatNum(ra.avg_tokens).padStart(8) +
        formatNum(rb.avg_tokens).padStart(8)
    );
  }

  console.log(chalk.dim("─".repeat(75)));
  console.log("");
}

/**
 * Print a capability x difficulty matrix.
 * Groups results by capability (rows) and difficulty (columns).
 */
export function printCapabilityMatrix(results: EvalResult[]): void {
  // Collect unique capabilities and difficulties
  const capabilities = new Set<string>();
  const difficulties = new Set<string>();

  for (const r of results) {
    if (r.capability) capabilities.add(r.capability);
    if (r.difficulty) difficulties.add(r.difficulty);
  }

  if (capabilities.size === 0 && difficulties.size === 0) {
    return; // No matrix data available
  }

  // If only capability is set, show a simpler breakdown
  if (difficulties.size === 0) {
    console.log(chalk.bold("\nCapability Breakdown"));
    console.log(chalk.dim("─".repeat(45)));
    const byCapability = groupBy(results, (r) => r.capability ?? "other");
    for (const [cap, items] of Object.entries(byCapability).sort()) {
      const passRate = items.reduce((s, r) => s + r.pass_rate, 0) / items.length;
      const color = passRate >= 0.8 ? chalk.green : passRate >= 0.5 ? chalk.yellow : chalk.red;
      console.log(
        `  ${cap.padEnd(18)} ${color(`${(passRate * 100).toFixed(0)}%`.padStart(5))}  (${items.length} tasks)`
      );
    }
    console.log("");
    return;
  }

  const diffOrder = ["easy", "medium", "hard"];
  const sortedDiffs = [...difficulties].sort(
    (a, b) => diffOrder.indexOf(a) - diffOrder.indexOf(b)
  );

  // Build matrix: capability → difficulty → avg pass_rate
  const matrix: Record<string, Record<string, { rate: number; count: number }>> = {};
  for (const r of results) {
    const cap = r.capability ?? "other";
    const diff = r.difficulty ?? "unknown";
    if (!matrix[cap]) matrix[cap] = {};
    if (!matrix[cap][diff]) matrix[cap][diff] = { rate: 0, count: 0 };
    matrix[cap][diff].rate += r.pass_rate;
    matrix[cap][diff].count++;
  }

  console.log(chalk.bold("\nCapability x Difficulty Matrix"));
  console.log(chalk.dim("─".repeat(50)));

  // Header
  const header = "  " + "".padEnd(16) + sortedDiffs.map((d) => d.padStart(10)).join("");
  console.log(chalk.dim(header));

  // Rows
  for (const cap of [...capabilities].sort()) {
    let line = "  " + cap.padEnd(16);
    for (const diff of sortedDiffs) {
      const cell = matrix[cap]?.[diff];
      if (!cell) {
        line += chalk.dim("-".padStart(10));
      } else {
        const rate = cell.rate / cell.count;
        const color = rate >= 0.8 ? chalk.green : rate >= 0.5 ? chalk.yellow : chalk.red;
        line += color(`${(rate * 100).toFixed(0)}%`.padStart(10));
      }
    }
    console.log(line);
  }

  console.log("");
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(1)}c`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
