import { execSync } from "child_process";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import type {
  GraderConfig,
  GraderResult,
  CodeGraderConfig,
  LLMGraderConfig,
  SessionEntry,
} from "./types.js";
import { parseSessionFile } from "./parser.js";

/**
 * Run all graders for a task and return results.
 */
export async function runGraders(
  graders: GraderConfig[],
  cwd: string,
  transcriptPath: string
): Promise<GraderResult[]> {
  const results: GraderResult[] = [];

  for (const g of graders) {
    if (g.type === "code") {
      results.push(await runCodeGrader(g, cwd));
    } else if (g.type === "llm") {
      results.push(await runLLMGrader(g, transcriptPath));
    }
  }

  return results;
}

async function runCodeGrader(
  g: CodeGraderConfig,
  cwd: string
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
        });
        return {
          ...base,
          passed: true,
          score: 1,
          detail: `Command passed: ${g.command}\n${output.toString().slice(0, 200)}`,
        };
      } catch (err: any) {
        const stderr = err.stderr?.toString().slice(0, 300) ?? "";
        return {
          ...base,
          passed: false,
          score: 0,
          detail: `Command failed (exit ${err.status}): ${g.command}\n${stderr}`,
        };
      }
    }

    default:
      return { ...base, passed: false, score: 0, detail: `Unknown check: ${g.check}` };
  }
}

async function runLLMGrader(
  g: LLMGraderConfig,
  transcriptPath: string
): Promise<GraderResult> {
  const base = { name: g.name, type: "llm" as const };

  try {
    // Extract readable transcript
    const entries = await parseSessionFile(transcriptPath);
    const transcript = extractReadableTranscript(entries);

    // Build grading prompt
    const gradingPrompt = g.prompt.includes("{{transcript}}")
      ? g.prompt.replace("{{transcript}}", transcript)
      : `${g.prompt}\n\n---\nSession transcript:\n${transcript}`;

    const fullPrompt =
      gradingPrompt +
      '\n\nRespond with ONLY a JSON object: {"score": <0.0 to 1.0>, "reason": "<brief explanation>"}';

    // Call claude -p for grading
    const model = g.model ?? "sonnet";
    const output = execSync(
      `claude -p ${JSON.stringify(fullPrompt)} --model ${model} --output-format text --dangerously-skip-permissions`,
      { stdio: "pipe", timeout: 120_000 }
    );

    const text = output.toString().trim();
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
            const content =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
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
