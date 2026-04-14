import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { extractReadableTranscript } from "../src/grader.js";
import type { SessionEntry } from "../src/types.js";
import { assistant, toolResults, userText } from "./helpers.js";

// We import runGraders indirectly by testing runCodeGrader behavior through runGraders
import { runGraders } from "../src/grader.js";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "grader-test-"));
  await writeFile(join(tempDir, "hello.txt"), "Hello World\nfoo bar baz\n");
  await mkdir(join(tempDir, "sub"), { recursive: true });
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("code grader: file_exists", () => {
  it("passes when file exists", async () => {
    const results = await runGraders(
      [{ type: "code", name: "exists-check", check: "file_exists", path: "hello.txt" }],
      tempDir,
      "",
    );
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].score).toBe(1);
  });

  it("fails when file does not exist", async () => {
    const results = await runGraders(
      [{ type: "code", name: "exists-check", check: "file_exists", path: "nope.txt" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].score).toBe(0);
  });
});

describe("code grader: file_contains", () => {
  it("passes when pattern matches", async () => {
    const results = await runGraders(
      [{ type: "code", name: "contains-check", check: "file_contains", path: "hello.txt", pattern: "foo bar" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(true);
  });

  it("passes with regex pattern", async () => {
    const results = await runGraders(
      [{ type: "code", name: "regex-check", check: "file_contains", path: "hello.txt", pattern: "^Hello" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails when pattern does not match", async () => {
    const results = await runGraders(
      [{ type: "code", name: "contains-check", check: "file_contains", path: "hello.txt", pattern: "NOTHERE" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(false);
  });

  it("fails when file does not exist", async () => {
    const results = await runGraders(
      [{ type: "code", name: "contains-check", check: "file_contains", path: "missing.txt", pattern: "x" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].detail).toContain("Error reading");
  });
});

describe("code grader: file_not_contains", () => {
  it("passes when pattern is absent", async () => {
    const results = await runGraders(
      [{ type: "code", name: "not-contains", check: "file_not_contains", path: "hello.txt", pattern: "ABSENT" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails when pattern is present", async () => {
    const results = await runGraders(
      [{ type: "code", name: "not-contains", check: "file_not_contains", path: "hello.txt", pattern: "Hello" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(false);
  });
});

describe("code grader: command", () => {
  it("passes when command exits 0", async () => {
    const results = await runGraders(
      [{ type: "code", name: "cmd-check", check: "command", command: "echo ok" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(true);
    expect(results[0].score).toBe(1);
  });

  it("fails when command exits non-zero", async () => {
    const results = await runGraders(
      [{ type: "code", name: "cmd-check", check: "command", command: "exit 1" }],
      tempDir,
      "",
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].score).toBe(0);
    expect(results[0].detail).toContain("Command failed");
  });
});

describe("extractReadableTranscript", () => {
  it("formats user text and assistant tool calls", () => {
    const entries: SessionEntry[] = [
      userText("fix the bug"),
      assistant("m1", [{ name: "Read", file_path: "/p/a.ts" }]),
      toolResults([{ tool_use_id: "m1_tu0" }]),
    ];

    const transcript = extractReadableTranscript(entries);
    expect(transcript).toContain("[User] fix the bug");
    expect(transcript).toContain("[ToolUse] Read(");
    expect(transcript).toContain("[ToolResult]");
  });

  it("marks error tool results", () => {
    const entries: SessionEntry[] = [
      assistant("m1", [{ name: "Bash" }]),
      toolResults([{ tool_use_id: "m1_tu0", is_error: true }]),
    ];

    const transcript = extractReadableTranscript(entries);
    expect(transcript).toContain("[ToolResult ERROR]");
  });

  it("returns empty string for empty entries", () => {
    expect(extractReadableTranscript([])).toBe("");
  });
});
