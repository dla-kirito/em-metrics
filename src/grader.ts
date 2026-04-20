import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import { dirname, join } from "path";
import type {
  GraderConfig,
  GraderResult,
  CodeGraderConfig,
  LLMGraderConfig,
  SessionEntry,
} from "./types.js";
import { parseSessionFile } from "./parser.js";
import { parseCocoSession } from "./coco-parser.js";

/**
 * Run all graders for a task and return results.
 * @param source - "claude" or "coco", determines transcript parsing strategy
 */
export async function runGraders(
  graders: GraderConfig[],
  cwd: string,
  transcriptPath: string,
  source?: "claude" | "coco",
  sessionId?: string
): Promise<GraderResult[]> {
  const results: GraderResult[] = [];

  for (const g of graders) {
    if (g.type === "code") {
      results.push(await runCodeGrader(g, cwd, transcriptPath, sessionId));
    } else if (g.type === "llm") {
      results.push(await runLLMGrader(g, transcriptPath, source));
    }
  }

  return results;
}

async function runCodeGrader(
  g: CodeGraderConfig,
  cwd: string,
  transcriptPath?: string,
  sessionId?: string
): Promise<GraderResult> {
  const base = { name: g.name, type: "code" as const };

  switch (g.check) {
    case "file_exists": {
      const target = join(cwd, g.path!);
      try {
        await stat(target);
        return { ...base, passed: true, score: 1, detail: `File exists: ${g.path}` };
      } catch {
        return { ...base, passed: false, score: 0, detail: `File not found: ${g.path}` };
      }
    }

    case "file_contains": {
      const target = join(cwd, g.path!);
      try {
        const content = await readFile(target, "utf-8");
        const regex = new RegExp(g.pattern!, "m");
        const match = regex.test(content);
        return {
          ...base,
          passed: match,
          score: match ? 1 : 0,
          detail: match
            ? `Pattern "${g.pattern}" found in ${g.path}`
            : `Pattern "${g.pattern}" not found in ${g.path}`,
        };
      } catch (err) {
        return { ...base, passed: false, score: 0, detail: `Error reading ${g.path}: ${err}` };
      }
    }

    case "file_not_contains": {
      const target = join(cwd, g.path!);
      try {
        const content = await readFile(target, "utf-8");
        const regex = new RegExp(g.pattern!, "m");
        const match = regex.test(content);
        return {
          ...base,
          passed: !match,
          score: !match ? 1 : 0,
          detail: !match
            ? `Pattern "${g.pattern}" correctly absent from ${g.path}`
            : `Pattern "${g.pattern}" still present in ${g.path}`,
        };
      } catch (err) {
        return { ...base, passed: false, score: 0, detail: `Error reading ${g.path}: ${err}` };
      }
    }

    case "command": {
      try {
        const output = execSync(g.command!, {
          cwd,
          stdio: "pipe",
          timeout: 60_000,
          env: {
            ...process.env,
            EVAL_SESSION_ID: sessionId ?? "",
            EVAL_SESSION_JSONL: transcriptPath ?? "",
            EVAL_SANDBOX_CWD: cwd,
          },
        });
        return {
          ...base,
          passed: true,
          score: 1,
          detail: `Command passed: ${g.command}\n${output.toString().slice(0, 200)}`,
        };
      } catch (err: any) {
        const stderr = err.stderr?.toString().slice(0, 300) ?? "";
        const stdout = err.stdout?.toString().slice(0, 500) ?? "";
        return {
          ...base,
          passed: false,
          score: 0,
          detail: `Command failed (exit ${err.status}): ${g.command}\n${stdout}${stderr}`,
        };
      }
    }

    default:
      return { ...base, passed: false, score: 0, detail: `Unknown check: ${g.check}` };
  }
}

async function runLLMGrader(
  g: LLMGraderConfig,
  transcriptPath: string,
  source?: "claude" | "coco"
): Promise<GraderResult> {
  const base = { name: g.name, type: "llm" as const };

  try {
    // Extract readable transcript — use appropriate parser based on source
    let entries: SessionEntry[];
    if (source === "coco") {
      const sessionDir = dirname(transcriptPath); // events.jsonl → session dir
      const { entries: cocoEntries } = await parseCocoSession(sessionDir);
      entries = cocoEntries;
    } else {
      entries = await parseSessionFile(transcriptPath);
    }
    const transcript = extractReadableTranscript(entries);

    // Build grading prompt
    const gradingPrompt = g.prompt.includes("{{transcript}}")
      ? g.prompt.replace("{{transcript}}", transcript)
      : `${g.prompt}\n\n---\nSession transcript:\n${transcript}`;

    const fullPrompt =
      gradingPrompt +
      '\n\nRespond with ONLY a JSON object: {"score": <0.0 to 1.0>, "reason": "<brief explanation>"}';

    // Call LLM for grading — prefer coco for coco-source evals, claude otherwise
    const gradeBinary = findGradingBinary(source);
    const gradeArgs = buildGradingArgs(gradeBinary, fullPrompt, g.model);
    const result = spawnSync(gradeBinary, gradeArgs, {
      stdio: "pipe",
      timeout: 120_000,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0 && result.status !== null) {
      throw new Error(
        `${gradeBinary} exited with code ${result.status}: ${result.stderr?.toString().slice(0, 300)}`
      );
    }

    const text = result.stdout.toString().trim();
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (!jsonMatch) {
      return { ...base, passed: false, score: 0, detail: `Could not parse LLM response: ${text.slice(0, 200)}` };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { score: number; reason?: string };
    const threshold = g.threshold ?? 0.7;
    const passed = parsed.score >= threshold;

    return {
      ...base,
      passed,
      score: parsed.score,
      detail: parsed.reason ?? `Score: ${parsed.score} (threshold: ${threshold})`,
    };
  } catch (err: any) {
    return { ...base, passed: false, score: 0, detail: `LLM grader error: ${err.message}` };
  }
}

/**
 * Extract a human-readable transcript from session entries.
 * Used by LLM graders to understand what happened.
 */
export function extractReadableTranscript(entries: SessionEntry[]): string {
  const lines: string[] = [];
  const MAX_RESULT_LEN = 500;

  for (const entry of entries) {
    if (entry.type === "user" && "message" in entry) {
      const msg = (entry as any).message;
      if (typeof msg?.content === "string") {
        lines.push(`[User] ${msg.content}`);
      } else if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            lines.push(`[User] ${block.text}`);
          } else if (block.type === "tool_result") {
            const rawContent = block.content;
            const content =
              rawContent === undefined || rawContent === null
                ? ""
                : typeof rawContent === "string"
                  ? rawContent
                  : JSON.stringify(rawContent);
            const truncated =
              content.length > MAX_RESULT_LEN
                ? content.slice(0, MAX_RESULT_LEN) + "...(truncated)"
                : content;
            const errTag = block.is_error ? " ERROR" : "";
            lines.push(`[ToolResult${errTag}] ${truncated}`);
          }
        }
      }
    }

    if (entry.type === "assistant" && "message" in entry) {
      const msg = (entry as any).message;
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            lines.push(`[Assistant] ${block.text}`);
          } else if (block.type === "tool_use") {
            const inputStr = JSON.stringify(block.input);
            const truncated =
              inputStr.length > MAX_RESULT_LEN
                ? inputStr.slice(0, MAX_RESULT_LEN) + "..."
                : inputStr;
            lines.push(`[ToolUse] ${block.name}(${truncated})`);
          }
        }
      }
    }
  }

  // Cap total transcript size for LLM context
  const full = lines.join("\n");
  if (full.length > 50_000) {
    return full.slice(0, 50_000) + "\n...(transcript truncated)";
  }
  return full;
}

/**
 * Find the best available binary for LLM grading.
 * For coco-source evals, prefer coco (avoids claude model-access issues).
 * For claude-source evals, prefer claude.
 */
function findGradingBinary(source?: "claude" | "coco"): string {
  const order = source === "coco"
    ? ["coco", "claude"]
    : ["claude", "coco"];

  for (const bin of order) {
    try {
      execSync(`which ${bin}`, { stdio: "pipe" });
      return bin;
    } catch {
      // not found, try next
    }
  }
  const symlink = join(process.env.HOME ?? "", ".local", "bin", "trae-cli-eval");
  if (existsSync(symlink)) return symlink;
  return order[0]; // will fail with a clear error
}

/**
 * Build CLI args for the grading binary.
 * Returns an array of arguments (for spawnSync, avoids shell escaping issues).
 */
function buildGradingArgs(binary: string, prompt: string, model?: string): string[] {
  if (binary.includes("claude")) {
    const m = model ?? "sonnet";
    return ["-p", prompt, "--model", m, "--output-format", "text", "--dangerously-skip-permissions"];
  }
  // coco: use -p and --yolo, no --model flag
  return ["-p", prompt, "--yolo"];
}
