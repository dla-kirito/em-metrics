import { load } from "js-yaml";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import type { EvalTask } from "./types.js";

/**
 * Load a single eval task from a YAML file.
 */
export async function loadTask(filePath: string): Promise<EvalTask> {
  const content = await readFile(filePath, "utf-8");
  const raw = load(content) as Record<string, unknown>;
  return validateTask(raw, filePath);
}

/**
 * Load all .yaml/.yml task files from a directory.
 */
export async function loadTaskSuite(dirPath: string): Promise<EvalTask[]> {
  const files = await readdir(dirPath);
  const yamlFiles = files.filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml")
  );

  if (yamlFiles.length === 0) {
    throw new Error(`No .yaml/.yml files found in ${dirPath}`);
  }

  const tasks: EvalTask[] = [];
  for (const f of yamlFiles.sort()) {
    tasks.push(await loadTask(join(dirPath, f)));
  }
  return tasks;
}

function validateTask(raw: Record<string, unknown>, source: string): EvalTask {
  if (!raw.id || typeof raw.id !== "string") {
    throw new Error(`Task in ${source} missing required field: id`);
  }
  if (!raw.prompt || typeof raw.prompt !== "string") {
    throw new Error(`Task ${raw.id} in ${source} missing required field: prompt`);
  }
  if (!raw.cwd || typeof raw.cwd !== "string") {
    throw new Error(`Task ${raw.id} in ${source} missing required field: cwd`);
  }

  return {
    id: raw.id as string,
    name: (raw.name as string) ?? raw.id,
    prompt: raw.prompt as string,
    cwd: raw.cwd as string,
    setup: asStringArray(raw.setup),
    teardown: asStringArray(raw.teardown),
    graders: validateGraders(raw.graders),
    model: raw.model as string | undefined,
    max_budget_usd: raw.max_budget_usd as number | undefined,
    timeout_s: (raw.timeout_s as number) ?? 300,
    allowed_tools: asStringArray(raw.allowed_tools),
    system_prompt: raw.system_prompt as string | undefined,
    tags: asStringArray(raw.tags),
    trials: (raw.trials as number) ?? 1,
    difficulty: raw.difficulty as EvalTask["difficulty"],
    capability: raw.capability as string | undefined,
    source: raw.source as EvalTask["source"],
    binary: raw.binary as string | undefined,
    prompts: asStringArray(raw.prompts),
  };
}

function asStringArray(val: unknown): string[] | undefined {
  if (!val) return undefined;
  if (Array.isArray(val)) return val.map(String);
  return undefined;
}

function validateGraders(val: unknown): EvalTask["graders"] {
  if (!val || !Array.isArray(val)) return [];

  return val.map((g: Record<string, unknown>, i: number) => {
    if (!g.type || !g.name) {
      throw new Error(`Grader #${i} missing type or name`);
    }

    if (g.type === "code") {
      if (!g.check) throw new Error(`Code grader "${g.name}" missing check`);
      return {
        type: "code" as const,
        name: g.name as string,
        check: g.check as "file_exists" | "file_contains" | "command" | "file_not_contains",
        path: g.path as string | undefined,
        pattern: g.pattern as string | undefined,
        command: g.command as string | undefined,
      };
    }

    if (g.type === "llm") {
      if (!g.prompt) throw new Error(`LLM grader "${g.name}" missing prompt`);
      return {
        type: "llm" as const,
        name: g.name as string,
        prompt: g.prompt as string,
        model: g.model as string | undefined,
        threshold: (g.threshold as number) ?? 0.7,
      };
    }

    throw new Error(`Unknown grader type: ${g.type}`);
  });
}
