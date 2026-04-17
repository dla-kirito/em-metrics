import { execSync, spawn as nodeSpawn } from "child_process";
import { randomUUID } from "crypto";
import { homedir, platform } from "os";
import { join } from "path";
import { stat } from "fs/promises";
import chalk from "chalk";
import type { EvalTask, TrialResult, EvalSessionMetrics } from "./types.js";
import { parseSessionFile } from "./parser.js";
import { parseCocoSession } from "./coco-parser.js";
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

  // 1. Setup — run from home dir since task.cwd may not exist yet (setup creates it)
  if (task.setup?.length) {
    for (const cmd of task.setup) {
      try {
        execSync(cmd, { cwd: homedir(), stdio: "pipe", timeout: 60_000 });
      } catch (err: any) {
        return makeErrorResult(task, trialIndex, sessionId, `Setup failed: ${cmd}\n${err.message}`);
      }
    }
  }

  // 2. Build command and execute
  const binary = getBinary(task);
  const timeoutMs = (task.timeout_s ?? 300) * 1000;
  let claudeOutput: string;
  let claudeError = "";

  try {
    // Multi-turn: run preliminary prompts first (ungraded)
    if (task.prompts?.length) {
      for (const p of task.prompts) {
        const prelimId = randomUUID();
        const prelimArgs = buildArgs({ ...task, prompt: p }, prelimId, model);
        await spawnBinary(binary, prelimArgs, task.cwd, timeoutMs);
      }
    }

    // Run the main (graded) prompt
    const args = buildArgs(task, sessionId, model);
    claudeOutput = await spawnBinary(binary, args, task.cwd, timeoutMs);
  } catch (err: any) {
    claudeError = err.message ?? String(err);
    claudeOutput = "";
  }

  // 4. Locate session data and extract metrics
  let metrics: EvalSessionMetrics;
  let transcriptExists = false;

  if (task.source === "coco") {
    const sessionDir = findCocoSessionDir(sessionId);
    try {
      await stat(sessionDir);
      transcriptExists = true;
      const { entries } = await parseCocoSession(sessionDir);
      metrics = extractMetrics(entries, sessionId);
    } catch {
      metrics = emptyMetrics(sessionId, model, Date.now() - startTime);
    }
  } else {
    const jsonlPath = findSessionJsonl(task.cwd, sessionId);
    try {
      await stat(jsonlPath);
      transcriptExists = true;
      const entries = await parseSessionFile(jsonlPath);
      metrics = extractMetrics(entries, sessionId);
    } catch {
      metrics = emptyMetrics(sessionId, model, Date.now() - startTime);
    }
  }

  // 5. Resolve transcript path for graders
  const transcriptPath = task.source === "coco"
    ? join(findCocoSessionDir(sessionId), "events.jsonl")
    : findSessionJsonl(task.cwd, sessionId);

  // 6. Run graders (only if task actually ran)
  let graderResults = task.graders.length > 0 && transcriptExists
    ? await runGraders(task.graders, task.cwd, transcriptPath, task.source)
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
    transcript_path: transcriptPath,
  };
}

function getBinary(task: EvalTask): string {
  let bin = task.binary ?? (task.source === "coco" ? "coco" : "claude");
  if (bin.startsWith("~/")) {
    bin = join(homedir(), bin.slice(2));
  }
  return bin;
}

function buildArgs(
  task: EvalTask,
  sessionId: string,
  model: string
): string[] {
  if (task.source === "coco") {
    return buildCocoArgs(task, sessionId, model);
  }
  return buildClaudeArgs(task, sessionId, model);
}

function buildCocoArgs(
  task: EvalTask,
  sessionId: string,
  model: string
): string[] {
  const args = [
    "-p",
    task.prompt,
    "--session-id",
    sessionId,
    "--yolo",
  ];

  // Only override model if explicitly set in the task YAML (Coco uses its config default otherwise)
  if (task.model) {
    args.push("-c", `model.name=${model}`);
  }

  if (task.allowed_tools?.length) {
    for (const t of task.allowed_tools) {
      args.push("--allowed-tool", t);
    }
  }

  return args;
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

function spawnBinary(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(binary, args, {
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
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `${binary} exited with code ${code}${stderr ? ": " + stderr.slice(0, 500) : ""}`
          )
        );
      }
    });
  });
}

/**
 * Find the Coco session directory based on session ID.
 * Coco stores sessions at ~/Library/Caches/coco/sessions/{session-id}/ (macOS)
 * or ~/.cache/coco/sessions/{session-id}/ (Linux).
 */
function findCocoSessionDir(sessionId: string): string {
  const base = platform() === "darwin"
    ? join(homedir(), "Library", "Caches", "coco", "sessions")
    : join(homedir(), ".cache", "coco", "sessions");
  return join(base, sessionId);
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
    mcp_tool_calls: 0,
    mcp_servers_used: [],
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
    one_shot: false,
    shot_bucket: "1",
    cost_usd: 0,
    user_messages: 0,
    user_turns: 0,
    tool_rejections: 0,
    tool_errors: 0,
    user_followup_count: 0,
    files_re_edited: 0,
    abandonment: true,
    tokens_per_loc: null,
    tool_success_rate: 1,
    exploration_ratio: 0,
    edit_precision: 1,
    message_count: 0,
    output_chars_total: 0,
    thinking_chars_total: 0,
    tool_use_chars_p50: 0,
    tool_use_chars_p90: 0,
    tool_result_chars_p50: 0,
    tool_result_chars_p90: 0,
    file_ext_distribution: {},
    server_tool_usage: {},
    model_usage: {},
    cache_break_count: 0,
    permission_mode: "",
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
