import chalk from "chalk";
import type { EvalTask, TrialResult, EvalResult } from "./types.js";
import { runTrial } from "./runner.js";

/**
 * Execute all trials of an eval task and compute aggregate metrics.
 */
export async function runEval(
  task: EvalTask,
  modelOverride?: string
): Promise<EvalResult> {
  const trials: TrialResult[] = [];
  const k = task.trials ?? 1;
  const model = modelOverride ?? task.model ?? "sonnet";

  for (let i = 0; i < k; i++) {
    process.stderr.write(
      chalk.dim(`  [${task.id}] Trial ${i + 1}/${k}...`)
    );
    const startMs = Date.now();
    const result = await runTrial(task, i, model);
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

    const status = result.passed
      ? chalk.green("PASS")
      : chalk.red("FAIL");
    process.stderr.write(` ${status} (${elapsed}s)\n`);

    if (result.error) {
      process.stderr.write(chalk.yellow(`    Error: ${result.error.slice(0, 120)}\n`));
    }

    trials.push(result);
  }

  return computeEvalResult(task, model, trials);
}

/**
 * Run a suite of eval tasks sequentially.
 */
export async function runEvalSuite(
  tasks: EvalTask[],
  modelOverride?: string
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    process.stderr.write(
      chalk.bold(`\n[${i + 1}/${tasks.length}] ${task.name ?? task.id}\n`)
    );
    const result = await runEval(task, modelOverride);
    results.push(result);
  }

  return results;
}

function computeEvalResult(
  task: EvalTask,
  model: string,
  trials: TrialResult[]
): EvalResult {
  const k = trials.length;
  const passCount = trials.filter((t) => t.passed).length;
  const passRate = k > 0 ? passCount / k : 0;

  // pass@k: probability that at least one trial passes in k attempts
  // Using the unbiased estimator: 1 - C(n-c, k) / C(n, k)
  // For k=n this simplifies to: passCount > 0 ? 1 : 0
  // For general use, approximate with: 1 - (1 - p)^k
  const pass_at_k = 1 - Math.pow(1 - passRate, k);

  // pass^k: probability that ALL k trials pass
  const pass_pow_k = Math.pow(passRate, k);

  const validTrials = trials.filter((t) => !t.error);

  return {
    task_id: task.id,
    task_name: task.name ?? task.id,
    model,
    trials,
    pass_at_k,
    pass_pow_k,
    pass_rate: passRate,
    avg_score: avg(trials.map((t) => t.score)),
    avg_turns: avg(validTrials.map((t) => t.metrics.api_calls)),
    avg_tokens: avg(validTrials.map((t) => t.metrics.total_output_tokens)),
    avg_duration_ms: avg(validTrials.map((t) => t.metrics.wall_duration_ms)),
    avg_cost_usd: avg(validTrials.map((t) => t.metrics.cost_usd)),
    tags: task.tags,
    difficulty: task.difficulty,
    capability: task.capability,
    // flakiness: 0 = all same outcome, 1 = exactly 50/50
    flakiness: k > 1 ? 1 - Math.abs(passRate - 0.5) * 2 : 0,
  };
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
