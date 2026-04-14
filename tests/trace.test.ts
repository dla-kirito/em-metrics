import { describe, it, expect } from "vitest";
import { extractTrace } from "../src/trace.js";
import type { SessionEntry } from "../src/types.js";
import { assistant, toolResults, userText } from "./helpers.js";

describe("extractTrace", () => {
  it("detects file_re_edit signal when same file is edited 3+ times", () => {
    const entries: SessionEntry[] = [
      userText("fix it"),
      assistant("m1", [{ name: "Edit", file_path: "/p/src/foo.ts" }]),
      toolResults([{ tool_use_id: "m1_tu0" }]),
      assistant("m2", [{ name: "Edit", file_path: "/p/src/foo.ts" }]),
      toolResults([{ tool_use_id: "m2_tu0" }]),
      assistant("m3", [{ name: "Edit", file_path: "/p/src/foo.ts" }]),
      toolResults([{ tool_use_id: "m3_tu0" }]),
    ];

    const trace = extractTrace(entries, "sess1");
    const signalTypes = trace.signals.map((s) => s.type);
    expect(signalTypes).toContain("file_re_edit");
  });

  it("detects user_correction signal when user sends text after end_turn", () => {
    const entries: SessionEntry[] = [
      userText("do A", { timestamp: "2026-01-01T00:00:00Z" }),
      assistant("m1", [{ name: "Bash", command: "echo hi" }], {
        stop_reason: "end_turn",
        timestamp: "2026-01-01T00:00:01Z",
      }),
      toolResults([{ tool_use_id: "m1_tu0" }], {
        timestamp: "2026-01-01T00:00:02Z",
      }),
      userText("actually do B", { timestamp: "2026-01-01T00:00:03Z" }),
    ];

    const trace = extractTrace(entries, "sess2");
    const signalTypes = trace.signals.map((s) => s.type);
    expect(signalTypes).toContain("user_correction");
  });

  it("produces correct steps structure for a basic trace", () => {
    const entries: SessionEntry[] = [
      userText("hello", { timestamp: "2026-01-01T00:00:00Z" }),
      assistant("m1", [{ name: "Read", file_path: "/p/src/a.ts" }], {
        stop_reason: "tool_use",
        timestamp: "2026-01-01T00:00:01Z",
      }),
      toolResults([{ tool_use_id: "m1_tu0" }], {
        timestamp: "2026-01-01T00:00:02Z",
      }),
      assistant("m2", [], {
        stop_reason: "end_turn",
        timestamp: "2026-01-01T00:00:03Z",
      }),
    ];

    const trace = extractTrace(entries, "sess3");
    expect(trace.session_id).toBe("sess3");
    expect(trace.model).toBe("claude-sonnet-4-6");
    // Should have at least user_text + tool_call + tool_result steps
    const types = trace.steps.map((s) => s.type);
    expect(types).toContain("user_text");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    // Steps should be re-indexed
    for (let i = 0; i < trace.steps.length; i++) {
      expect(trace.steps[i].index).toBe(i);
    }
  });
});
