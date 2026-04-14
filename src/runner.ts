import { execSync, spawn as nodeSpawn } from "child_process";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { stat } from "fs/promises";
import chalk from "chalk";
import type { EvalTask, TrialResult, EvalSessionMetrics } from "./types.js";
import { parseSessionFile } from "./parser.js";
import { extractMetrics } from "./metrics.js";
import { runGraders } from "./grader.js";

/**
 * Execute a single trial of an eval task.
 */
export async function runTrial(
  task: EvalTask,
  trialIndex: number,
  modelOverride?: string
): Promise<TrialResult> {
  const sessionId = randomUUID();
  const model = modelOverride ?? task.model ?? "sonnet";
  const startTime = Date.now();

  // 1. Setup
  if (task.setup?.length) {
    for (const cmd of task.setup) {
      try {
        execSync(cmd, { cwd: task.cwd, stdio: "pipe", timeout: 60_000 });
      } catch (err: any) {
        return makeErrorResult(task, trialIndex, sessionId, `Setup failed: ${cmd}\n${err.message}`);
      }
    }
  }

  // 2. Build claude command
  const args = buildClaudeArgs(task, sessionId, model);

  // 3. Execute claude -p
  let claudeOutput: string;
  let claudeError = "";
  try {
    claudeOutput = await spawnClaude(args, task.cwd, (task.timeout_s ?? 300) * 1000);
  } catch (err: any) {
    claudeError = err.message ?? String(err);
    claudeOutput = "";
  }

  // 4. Locate JSONL file
  const jsonlPath = findSessionJsonl(task.cwd, sessionId);
  let metrics: EvalSessionMetrics;
  let transcriptExists = false;

  try {
    await stat(jsonlPath);
    transcriptExists = true;
    const entries = await parseSessionFile(jsonlPath);
    metrics = extractMetrics(entries, sessionId);
  } catch {
    metrics = emptyMetrics(sessionId, model, Date.now() - startTime);
  }

  // 5. Run graders (only if task actually ran)
  let graderResults = task.graders.length > 0 && transcriptExists
    ? await runGraders(task.graders, task.cwd, jsonlPath)
    : [];

  // If no graders defined, mark as passed if claude completed without error
  const passed =
    graderResults.length > 0
      ? graderResults.every((g) => g.passed)
      : !claudeError;

  const score =
    graderResults.length > 0
      ? graderResults.reduce((sum, g) => sum + g.score, 0) / graderResults.length
      : passed
        ? 1
        : 0;

  // 6. Teardown
  if (task.teardown?.length) {
    for (const cmd of task.teardown) {
      try {
        execSync(cmd, { cwd: task.cwd, stdio: "pipe", timeout: 60_000 });
      } catch {
        // Teardown errors are non-fatal
      }
    }
  }

  return {
    task_id: task.id,
    trial_index: trialIndex,
    session_id: sessionId,
    metrics,
    grader_results: graderResults,
    passed,
    score,
    error: claudeError || undefined,
    transcript_path: jsonlPath,
  };
}

function buildClaudeArgs(
  task: EvalTask,
  sessionId: string,
  model: string
): string[] {
  const args = [
    "-p",
    task.prompt,
    "--output-format",
    "json",
    "--session-id",
    sessionId,
    "--dangerously-skip-permissions",
    "--model",
    model,
  ];

  if (task.max_budget_usd) {
    args.push("--max-budget-usd", String(task.max_budget_usd));
  }
  if (task.allowed_tools?.length) {
    args.push("--allowedTools", ...task.allowed_tools);
  }
  if (task.system_prompt) {
    args.push("--system-prompt", task.system_prompt);
  }

  return args;
}

function spawnClaude(
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `claude exited with code ${code}${stderr ? ": " + stderr.slice(0, 500) : ""}`
          )
        );
      }
    });
  });
}

/**
 * Find the session JSONL file path based on cwd and session ID.
 * Claude Code stores sessions at ~/.claude/projects/{cwd-hash}/{session-id}.jsonl
 */
function findSessionJsonl(cwd: string, sessionId: string): string {
  const cwdKey = cwd.replace(/\//g, "-");
  return join(
    homedir(),
    ".claude",
    "projects",
    cwdKey,
    `${sessionId}.jsonl`
  );
}

function emptyMetrics(
  sessionId: string,
  model: string,
  durationMs: number
): EvalSessionMetrics {
  return {
    session_id: sessionId,
    model,
    started_at: "",
    ended_at: "",
    wall_duration_ms: durationMs,
    active_duration_ms: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    overall_cache_hit_rate: 0,
    api_calls: 0,
    api_retries: 0,
    total_tool_calls: 0,
    tool_breakdown: {},
    lines_added: 0,
    lines_removed: 0,
    files_changed: [],
    compact_count: 0,
    max_context_tokens: 0,
    stop_reason: "error",
    turns_detail: [],
    cache_hit_rate_trend: [],
    sidechain_turns: 0,
    mainchain_turns: 0,
    cost_usd: 0,
    user_messages: 0,
    user_turns: 0,
    tool_rejections: 0,
    tool_errors: 0,
    correction_count: 0,
    files_re_edited: 0,
    abandonment: true,
    tokens_per_loc: null,
    tool_success_rate: 1,
    exploration_ratio: 0,
    edit_precision: 1,
  };
}

function makeErrorResult(
  task: EvalTask,
  trialIndex: number,
  sessionId: string,
  error: string
): TrialResult {
  return {
    task_id: task.id,
    trial_index: trialIndex,
    session_id: sessionId,
    metrics: emptyMetrics(sessionId, task.model ?? "unknown", 0),
    grader_results: [],
    passed: false,
    score: 0,
    error,
    transcript_path: "",
  };
}
