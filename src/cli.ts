#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { join } from "path";
import { homedir } from "os";
import { readdir, stat, readFile, writeFile, mkdir } from "fs/promises";
import { SessionWatcher } from "./watcher.js";
import { processEntry } from "./metrics.js";
import { createEmptyLiveMetrics } from "./types.js";
import { renderDashboard, renderSummary } from "./dashboard.js";
import { extractMetrics } from "./metrics.js";
import { loadTask, loadTaskSuite } from "./task.js";
import { runEval, runEvalSuite } from "./eval.js";
import { printEvalResult, printEvalSummary, printComparison } from "./reporter.js";
import type { SessionEntry, EvalSessionMetrics, EvalResult } from "./types.js";
import { extractTrace, renderTrace } from "./trace.js";
import { buildProfile, renderProfile } from "./profile.js";
import { findPatternsFromEntries, renderPatterns } from "./patterns.js";
import { resolveSession } from "./session-resolver.js";
import { collectSessionEntries, collectSessionMetrics } from "./session-collector.js";
import { printMetrics } from "./commands/show.js";
import { printAnalysis } from "./commands/analyze.js";
import { printRoi } from "./commands/roi.js";

const program = new Command();

program
  .name("em")
  .description("Real-time metrics collection for Claude Code sessions")
  .version("0.1.0");

// ── watch command ──────────────────────────────────────────────
program
  .command("watch")
  .description("Real-time monitor of the active Claude Code session")
  .option("--session <id>", "Watch a specific session by ID")
  .option("--cwd <path>", "Project directory to find sessions in")
  .action(async (opts) => {
    const watcher = new SessionWatcher();
    let metrics = createEmptyLiveMetrics("");
    let renderTimer: ReturnType<typeof setInterval> | null = null;

    watcher.on("session_start", (sessionId: string, filePath: string) => {
      metrics = createEmptyLiveMetrics(sessionId);
      console.log(
        chalk.dim(`Watching: ${filePath}`)
      );

      // Refresh display periodically
      renderTimer = setInterval(() => {
        process.stdout.write("\x1B[2J\x1B[H"); // Clear screen
        process.stdout.write(renderDashboard(metrics));
      }, 300);
    });

    watcher.on("entry", (entry: SessionEntry) => {
      processEntry(entry, metrics);
    });

    watcher.on("error", (err: Error) => {
      console.error(chalk.red(`Error: ${err.message}`));
      if (err.message.includes("No active session")) {
        console.log(chalk.dim("Start a Claude Code session first, then run this command."));
        process.exit(1);
      }
    });

    // Graceful shutdown
    process.on("SIGINT", () => {
      if (renderTimer) clearInterval(renderTimer);
      metrics.is_running = false;
      watcher.stop();
      process.stdout.write("\x1B[2J\x1B[H");
      process.stdout.write(renderSummary(metrics));
      process.exit(0);
    });

    // Find session file
    let filePath: string | undefined;
    if (opts.session) {
      // Find by session ID
      const projectsDir = join(homedir(), ".claude", "projects");
      const dirs = await readdir(projectsDir).catch(() => []);
      for (const d of dirs) {
        const candidate = join(projectsDir, d as string, `${opts.session}.jsonl`);
        try {
          await stat(candidate);
          filePath = candidate;
          break;
        } catch {}
      }
      if (!filePath) {
        console.error(chalk.red(`Session ${opts.session} not found`));
        process.exit(1);
      }
    }

    await watcher.start(filePath);
  });

// ── show command ──────────────────────────────────────────────
program
  .command("show")
  .description("Show metrics for a completed session")
  .option("--session <id>", "Session ID")
  .option("--last", "Show the most recent session")
  .option("--json", "Output as JSON")
  .option("--detail", "Show per-turn detail")
  .option("--source <type>", "Session source: claude or coco", "claude")
  .action(async (opts) => {
    let resolved;
    try {
      resolved = await resolveSession(opts);
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }

    const result = extractMetrics(resolved.entries, resolved.sessionId);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printMetrics(result, opts.detail);
    }
  });

// ── analyze command ──────────────────────────────────────────────
program
  .command("analyze")
  .description("Analyze metrics across multiple sessions")
  .option("--since <date>", "Start date (YYYY-MM-DD)")
  .option("--until <date>", "End date (YYYY-MM-DD)")
  .option("--cwd <path>", "Project directory")
  .option("--json", "Output as JSON")
  .option("--source <type>", "Session source: claude or coco", "claude")
  .option("--limit <n>", "Limit JSON output to top N sessions", parseInt)
  .option("--sort <field>", "Sort field for --limit: cost_usd, wall_duration_ms, started_at (default)", "started_at")
  .option("--output <file>", "Write output to file instead of stdout")
  .option("--csv", "Output as CSV (implies --json-like tabular format)")
  .action(async (opts) => {
    const allMetrics = await collectSessionMetrics(opts);

    if (allMetrics.length === 0) {
      console.log(chalk.yellow("No sessions found in the specified range."));
      return;
    }

    // CSV export
    if (opts.csv) {
      const headers = [
        "session_id", "model", "started_at", "wall_duration_ms",
        "api_calls", "total_tool_calls",
        "total_input_tokens", "total_output_tokens",
        "total_cache_read_tokens", "total_cache_creation_tokens",
        "lines_added", "lines_removed", "files_changed",
        "compact_count", "stop_reason", "cost_usd",
      ];
      const rows = allMetrics.map((m) =>
        headers
          .map((h) => {
            const v = (m as any)[h];
            if (Array.isArray(v)) return v.length;
            return v ?? "";
          })
          .join(",")
      );
      const csvOutput = [headers.join(","), ...rows].join("\n");

      if (opts.output) {
        const { writeFileSync } = await import("fs");
        writeFileSync(opts.output, csvOutput);
        console.log(chalk.green(`Exported ${allMetrics.length} sessions (CSV) to ${opts.output}`));
      } else {
        console.log(csvOutput);
      }
      return;
    }

    // JSON export
    if (opts.json) {
      let output = allMetrics;
      if (opts.limit) {
        const field = opts.sort as keyof EvalSessionMetrics;
        output = [...allMetrics].sort((a, b) => {
          const va = (a as any)[field];
          const vb = (b as any)[field];
          if (typeof va === "number" && typeof vb === "number") return vb - va;
          return String(vb).localeCompare(String(va));
        }).slice(0, opts.limit);
      }
      const jsonOutput = JSON.stringify(output, null, 2);

      if (opts.output) {
        const { writeFileSync } = await import("fs");
        writeFileSync(opts.output, jsonOutput);
        console.log(chalk.green(`Exported ${allMetrics.length} sessions (JSON) to ${opts.output}`));
      } else {
        console.log(jsonOutput);
      }
      return;
    }

    // Default: human-readable analysis
    if (opts.output) {
      console.log(chalk.yellow("--output requires --json or --csv"));
      return;
    }

    printAnalysis(allMetrics);
  });

// ── trace command ──────────────────────────────────────────────
program
  .command("trace")
  .description("Show behavioral trace for a session (tool call sequence, signals)")
  .option("--session <id>", "Session ID")
  .option("--last", "Most recent session")
  .option("--source <type>", "Session source: claude or coco", "claude")
  .option("--json", "Output as JSON")
  .option("--verbose", "Include assistant text and tool result previews")
  .action(async (opts) => {
    let resolved;
    try {
      resolved = await resolveSession(opts);
    } catch (e: any) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }

    const trace = extractTrace(resolved.entries, resolved.sessionId, { verbose: !!opts.verbose });

    if (opts.json) {
      console.log(JSON.stringify(trace, null, 2));
    } else {
      console.log(renderTrace(trace));
    }
  });

// ── profile command ──────────────────────────────────────────────
program
  .command("profile")
  .description("Show agent capability profile by codebase module")
  .option("--since <date>", "Start date (YYYY-MM-DD)")
  .option("--until <date>", "End date (YYYY-MM-DD)")
  .option("--source <type>", "Session source: claude or coco", "claude")
  .option("--depth <n>", "Directory depth for aggregation", parseInt, 2)
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const sessions = await collectSessionEntries(opts);

    if (sessions.length === 0) {
      console.log(chalk.yellow("No sessions found."));
      return;
    }

    const profile = buildProfile(sessions, { depth: opts.depth });
    profile.period.since = opts.since ?? "";
    profile.period.until = opts.until ?? "";

    if (opts.json) {
      console.log(JSON.stringify(profile, null, 2));
    } else {
      console.log(renderProfile(profile));
    }
  });

// ── patterns command ──────────────────────────────────────────────
program
  .command("patterns")
  .description("Detect behavioral patterns across multiple sessions")
  .option("--since <date>", "Start date (YYYY-MM-DD)")
  .option("--until <date>", "End date (YYYY-MM-DD)")
  .option("--source <type>", "Session source: claude or coco", "claude")
  .option("--min-occurrences <n>", "Minimum occurrences to report", parseInt, 3)
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const sessions = await collectSessionEntries(opts);

    if (sessions.length === 0) {
      console.log(chalk.yellow("No sessions found."));
      return;
    }

    const patterns = findPatternsFromEntries(sessions, { minOccurrences: opts.minOccurrences });
    patterns.period.since = opts.since ?? "";
    patterns.period.until = opts.until ?? "";

    if (opts.json) {
      console.log(JSON.stringify(patterns, null, 2));
    } else {
      console.log(renderPatterns(patterns));
    }
  });

// ── roi command ──────────────────────────────────────────────
program
  .command("roi")
  .description("Show subscription ROI vs API equivalent cost")
  .option("--plan <plan>", "Subscription plan: pro ($20/mo), max5 ($100/mo), max20 ($200/mo)", "max5")
  .option("--since <date>", "Start date (YYYY-MM-DD), default: first day of current month")
  .option("--until <date>", "End date (YYYY-MM-DD), default: today")
  .option("--source <type>", "Session source: claude or coco", "claude")
  .action(async (opts) => {
    if (!opts.since) {
      const now = new Date();
      opts.since = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    }
    const allMetrics = await collectSessionMetrics(opts);
    if (allMetrics.length === 0) {
      console.log(chalk.yellow("No sessions found in the specified range."));
      return;
    }
    printRoi(allMetrics, opts);
  });

// ── eval command group ──────────────────────────────────────────
const evalCmd = program
  .command("eval")
  .description("Eval framework: run tasks, compare results, check regressions");

evalCmd
  .command("run")
  .description("Run a single eval task")
  .requiredOption("--task <file>", "Path to eval task YAML file")
  .option("--model <model>", "Override model")
  .option("--trials <n>", "Override number of trials", parseInt)
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const task = await loadTask(opts.task);
    if (opts.trials) task.trials = opts.trials;

    console.log(chalk.bold(`\nRunning eval: ${task.name ?? task.id}`));
    const result = await runEval(task, opts.model);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printEvalResult(result);
    }
  });

evalCmd
  .command("batch")
  .description("Run a suite of eval tasks")
  .requiredOption("--suite <dir>", "Directory containing eval YAML files")
  .option("--model <model>", "Override model for all tasks")
  .option("--trials <n>", "Override number of trials", parseInt)
  .option("--output <file>", "Save results to JSON file")
  .option("--history <dir>", "Auto-save results to history directory (timestamped)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const tasks = await loadTaskSuite(opts.suite);
    if (opts.trials) {
      for (const t of tasks) t.trials = opts.trials;
    }

    console.log(chalk.bold(`\nRunning eval suite: ${tasks.length} tasks`));
    const results = await runEvalSuite(tasks, opts.model);

    if (opts.output) {
      await writeFile(opts.output, JSON.stringify(results, null, 2));
      console.log(chalk.green(`Results saved to ${opts.output}`));
    }

    // Auto-save to history
    if (opts.history) {
      await mkdir(opts.history, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const histFile = join(opts.history, `${ts}.json`);
      await writeFile(histFile, JSON.stringify(results, null, 2));
      console.log(chalk.dim(`History saved to ${histFile}`));
    }

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printEvalSummary(results);
    }
  });

evalCmd
  .command("compare <fileA> <fileB>")
  .description("Compare two eval result files")
  .option("--label-a <name>", "Label for first result set", "A")
  .option("--label-b <name>", "Label for second result set", "B")
  .action(async (fileA: string, fileB: string, opts) => {
    const a: EvalResult[] = JSON.parse(await readFile(fileA, "utf-8"));
    const b: EvalResult[] = JSON.parse(await readFile(fileB, "utf-8"));

    printComparison(a, b, opts.labelA, opts.labelB);
  });

evalCmd
  .command("check")
  .description("Check for regressions against a baseline (CI-friendly, exits with code 1 on regression)")
  .requiredOption("--baseline <file>", "Baseline eval results JSON")
  .requiredOption("--current <file>", "Current eval results JSON")
  .option("--threshold <n>", "Pass rate drop threshold to flag regression (0-1)", parseFloat, 0.05)
  .action(async (opts) => {
    const baseline: EvalResult[] = JSON.parse(await readFile(opts.baseline, "utf-8"));
    const current: EvalResult[] = JSON.parse(await readFile(opts.current, "utf-8"));

    const baselineMap = new Map(baseline.map((r) => [r.task_id, r]));
    const regressions: string[] = [];
    const improvements: string[] = [];

    for (const cur of current) {
      const base = baselineMap.get(cur.task_id);
      if (!base) continue;

      const delta = cur.pass_rate - base.pass_rate;
      if (delta < -opts.threshold) {
        regressions.push(
          `  ${chalk.red("REGRESS")} ${cur.task_id}: ${(base.pass_rate * 100).toFixed(0)}% -> ${(cur.pass_rate * 100).toFixed(0)}% (${(delta * 100).toFixed(0)}%)`
        );
      } else if (delta > opts.threshold) {
        improvements.push(
          `  ${chalk.green("IMPROVE")} ${cur.task_id}: ${(base.pass_rate * 100).toFixed(0)}% -> ${(cur.pass_rate * 100).toFixed(0)}% (+${(delta * 100).toFixed(0)}%)`
        );
      }
    }

    console.log(chalk.bold(`\nRegression check (threshold: ${(opts.threshold * 100).toFixed(0)}%)\n`));

    if (improvements.length > 0) {
      console.log(chalk.green(`Improvements (${improvements.length}):`));
      improvements.forEach((l) => console.log(l));
    }

    if (regressions.length > 0) {
      console.log(chalk.red(`\nRegressions (${regressions.length}):`));
      regressions.forEach((l) => console.log(l));
      console.log(chalk.red("\nFAILED: Regressions detected"));
      process.exit(1);
    } else {
      console.log(chalk.green("\nPASSED: No regressions detected"));
    }
    console.log("");
  });

evalCmd
  .command("trend")
  .description("Show pass rate and cost trends across historical eval runs")
  .requiredOption("--history <dir>", "Directory containing eval result JSON files (one per run)")
  .option("--task <id>", "Filter to a specific task ID")
  .action(async (opts) => {
    const dir = opts.history;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

    if (files.length === 0) {
      console.log(chalk.yellow("No JSON result files found in " + dir));
      return;
    }

    // Load all runs
    interface RunSnapshot {
      file: string;
      date: string;
      results: EvalResult[];
    }
    const runs: RunSnapshot[] = [];
    for (const f of files) {
      const fp = join(dir, f);
      try {
        const data: EvalResult[] = JSON.parse(await readFile(fp, "utf-8"));
        const s = await stat(fp);
        runs.push({ file: f, date: s.mtime.toISOString().slice(0, 10), results: data });
      } catch {}
    }

    if (runs.length === 0) {
      console.log(chalk.yellow("No valid result files found"));
      return;
    }

    console.log(chalk.bold(`\nTrend: ${runs.length} runs from ${opts.history}\n`));

    // Collect all task IDs
    const allTaskIds = new Set<string>();
    for (const run of runs) {
      for (const r of run.results) allTaskIds.add(r.task_id);
    }

    const targetTasks = opts.task
      ? [opts.task]
      : [...allTaskIds].sort();

    // Header
    console.log(
      chalk.dim(
        "  " + "Run".padEnd(14) + targetTasks.map((t) => t.slice(0, 12).padStart(14)).join("") + "  Avg".padStart(8)
      )
    );

    // Sparkline chars for pass rate
    const sparkChar = (rate: number): string => {
      if (rate >= 0.9) return chalk.green("\u2588");
      if (rate >= 0.7) return chalk.green("\u2593");
      if (rate >= 0.5) return chalk.yellow("\u2592");
      if (rate >= 0.2) return chalk.red("\u2591");
      return chalk.dim("\u2591");
    };

    for (const run of runs) {
      const resultMap = new Map(run.results.map((r) => [r.task_id, r]));
      let line = "  " + run.date.padEnd(14);
      const rates: number[] = [];

      for (const taskId of targetTasks) {
        const r = resultMap.get(taskId);
        if (!r) {
          line += chalk.dim("-".padStart(14));
        } else {
          const pctStr = `${(r.pass_rate * 100).toFixed(0)}%`;
          const color = r.pass_rate >= 0.8 ? chalk.green : r.pass_rate >= 0.5 ? chalk.yellow : chalk.red;
          line += color(pctStr.padStart(14));
          rates.push(r.pass_rate);
        }
      }

      const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
      line += `  ${(avgRate * 100).toFixed(0)}%`.padStart(8);
      line += " " + rates.map(sparkChar).join("");

      console.log(line);
    }

    // Show trend direction
    if (runs.length >= 2) {
      const first = runs[0];
      const last = runs[runs.length - 1];
      const firstAvg = avgPassRate(first.results, targetTasks);
      const lastAvg = avgPassRate(last.results, targetTasks);
      const delta = lastAvg - firstAvg;
      const arrow = delta > 0.02 ? chalk.green("\u25B2") : delta < -0.02 ? chalk.red("\u25BC") : chalk.dim("\u25C6");
      console.log(
        `\n  ${arrow} Overall: ${(firstAvg * 100).toFixed(0)}% -> ${(lastAvg * 100).toFixed(0)}% (${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}%)`
      );
    }

    console.log("");
  });

function avgPassRate(results: EvalResult[], taskIds: string[]): number {
  let sum = 0;
  let count = 0;
  const map = new Map(results.map((r) => [r.task_id, r]));
  for (const id of taskIds) {
    const r = map.get(id);
    if (r) { sum += r.pass_rate; count++; }
  }
  return count > 0 ? sum / count : 0;
}

program.parse();
