import { describe, it, expect } from "vitest";
import { findPatterns } from "../src/patterns.js";
import type { TraceOutput, TraceStep } from "../src/types.js";

function makeTrace(
  sessionId: string,
  steps: Partial<TraceStep>[],
): TraceOutput {
  return {
    session_id: sessionId,
    model: "test",
    started_at: "2026-01-01T00:00:00Z",
    wall_duration_ms: 1000,
    cost_usd: 0.01,
    user_prompt: "test",
    total_steps: steps.length,
    steps: steps.map((s, i) => ({
      index: i,
      type: s.type ?? "tool_call",
      timestamp: "2026-01-01T00:00:00Z",
      is_sidechain: false,
      ...s,
    })),
    signals: [],
  };
}

describe("findPatterns", () => {
  it("detects edit-test-fail-loop (2+ cycles)", () => {
    // The detector looks at steps[i] through steps[i+3], needing i < length-4.
    // Two cycles need to be within that sliding window.
    const steps: Partial<TraceStep>[] = [
      // Cycle 1
      { type: "tool_call", tool_name: "Edit", tool_arg: "src/foo.ts" },
      { type: "tool_result", is_error: false },
      { type: "tool_call", tool_name: "Bash", tool_arg: "npm test" },
      { type: "tool_result", is_error: true },
      // Cycle 2
      { type: "tool_call", tool_name: "Edit", tool_arg: "src/foo.ts" },
      { type: "tool_result", is_error: false },
      { type: "tool_call", tool_name: "Bash", tool_arg: "npm test" },
      { type: "tool_result", is_error: true },
      // Extra step so cycle 2 is within i < length-4
      { type: "tool_call", tool_name: "Read", tool_arg: "src/foo.ts" },
    ];
    const result = findPatterns([makeTrace("s1", steps)], {
      minOccurrences: 1,
    });
    const ids = result.anti_patterns.map((p) => p.id);
    expect(ids).toContain("edit-test-fail-loop");
  });

  it("detects exploration-drift (3+ reads across different dirs)", () => {
    const steps: Partial<TraceStep>[] = [
      { type: "user_text", text: "find the bug" },
      { type: "tool_call", tool_name: "Read", tool_arg: "src/api/handler.ts" },
      { type: "tool_call", tool_name: "Grep", tool_arg: "lib/utils/format.ts" },
      { type: "tool_call", tool_name: "Glob", tool_arg: "tests/unit/spec.ts" },
    ];
    const result = findPatterns([makeTrace("s1", steps)], {
      minOccurrences: 1,
    });
    const ids = result.anti_patterns.map((p) => p.id);
    expect(ids).toContain("exploration-drift");
  });

  it("detects file-churn (same file edited 3+ times)", () => {
    const steps: Partial<TraceStep>[] = [
      { type: "user_text", text: "fix" },
      { type: "tool_call", tool_name: "Edit", tool_arg: "src/foo.ts" },
      { type: "tool_result", is_error: false },
      { type: "tool_call", tool_name: "Edit", tool_arg: "src/foo.ts" },
      { type: "tool_result", is_error: false },
      { type: "tool_call", tool_name: "Edit", tool_arg: "src/foo.ts" },
      { type: "tool_result", is_error: false },
    ];
    const result = findPatterns([makeTrace("s1", steps)], {
      minOccurrences: 1,
    });
    const ids = result.anti_patterns.map((p) => p.id);
    expect(ids).toContain("file-churn");
  });

  it("detects tool-error-chain (2+ consecutive errors)", () => {
    const steps: Partial<TraceStep>[] = [
      { type: "user_text", text: "do stuff" },
      { type: "tool_call", tool_name: "Bash", tool_arg: "cmd1" },
      { type: "tool_result", is_error: true },
      { type: "tool_result", is_error: true },
    ];
    const result = findPatterns([makeTrace("s1", steps)], {
      minOccurrences: 1,
    });
    const ids = result.anti_patterns.map((p) => p.id);
    expect(ids).toContain("tool-error-chain");
  });

  it("detects read-then-edit (read file, then edit same file successfully)", () => {
    const steps: Partial<TraceStep>[] = [
      { type: "user_text", text: "update handler" },
      {
        type: "tool_call",
        tool_name: "Read",
        tool_arg: "src/handler.ts",
      },
      { type: "tool_result", is_error: false },
      {
        type: "tool_call",
        tool_name: "Edit",
        tool_arg: "src/handler.ts",
      },
      { type: "tool_result", is_error: false },
    ];
    const result = findPatterns([makeTrace("s1", steps)], {
      minOccurrences: 1,
    });
    const ids = result.effective_patterns.map((p) => p.id);
    expect(ids).toContain("read-then-edit");
  });

  it("detects one-shot-complete (single user_text in trace)", () => {
    const steps: Partial<TraceStep>[] = [
      { type: "user_text", text: "do it" },
      { type: "tool_call", tool_name: "Bash", tool_arg: "echo hello" },
      { type: "tool_result", is_error: false },
    ];
    const result = findPatterns([makeTrace("s1", steps)], {
      minOccurrences: 1,
    });
    const ids = result.effective_patterns.map((p) => p.id);
    expect(ids).toContain("one-shot-complete");
  });

  it("returns no patterns for a minimal trace that triggers nothing", () => {
    // Two user_text steps (not one-shot), no tool calls
    const steps: Partial<TraceStep>[] = [
      { type: "user_text", text: "first" },
      { type: "user_text", text: "second" },
    ];
    const result = findPatterns([makeTrace("s1", steps)], {
      minOccurrences: 1,
    });
    expect(result.anti_patterns).toHaveLength(0);
    expect(result.effective_patterns).toHaveLength(0);
  });
});
