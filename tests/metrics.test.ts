import { describe, it, expect } from "vitest";
import { extractMetrics, deduplicateEntries, processEntry } from "../src/metrics.js";
import type { SessionEntry } from "../src/types.js";
import { createEmptyLiveMetrics } from "../src/types.js";
import { assistant, toolResults, userText } from "./helpers.js";

describe("extractMetrics", () => {
  it("returns api_calls = 0 for empty entries", () => {
    const m = extractMetrics([], "empty");
    expect(m.api_calls).toBe(0);
    expect(m.total_tool_calls).toBe(0);
  });

  it("reports correct tool_breakdown and total_tool_calls", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [
        { name: "Read", file_path: "/p/a.ts" },
        { name: "Edit", file_path: "/p/a.ts", old_string: "a", new_string: "b" },
      ]),
      toolResults([
        { tool_use_id: "m1_tu0" },
        { tool_use_id: "m1_tu1" },
      ]),
    ];
    const m = extractMetrics(entries, "s1");
    expect(m.total_tool_calls).toBe(2);
    expect(m.tool_breakdown["Read"]).toEqual({ count: 1, errors: 0 });
    expect(m.tool_breakdown["Edit"]).toEqual({ count: 1, errors: 0 });
  });

  it("increments correction_count on user text after end_turn", () => {
    // Pattern: user asks → assistant does work (tool_use) → tool results →
    // assistant concludes (end_turn, no tools) → user follows up = correction
    const entries: SessionEntry[] = [
      userText("do A", { timestamp: "2026-01-01T00:00:00Z" }),
      assistant("m1", [{ name: "Bash" }], {
        stop_reason: "tool_use",
        timestamp: "2026-01-01T00:00:01Z",
      }),
      toolResults([{ tool_use_id: "m1_tu0" }], {
        timestamp: "2026-01-01T00:00:02Z",
      }),
      // Assistant concludes with end_turn (no tool calls but still an assistant turn)
      assistant("m2", [], {
        stop_reason: "end_turn",
        timestamp: "2026-01-01T00:00:03Z",
      }),
      // User follows up after assistant said end_turn = correction
      userText("actually do B", { timestamp: "2026-01-01T00:00:05Z" }),
    ];
    const m = extractMetrics(entries, "s2");
    expect(m.correction_count).toBeGreaterThanOrEqual(1);
  });

  it("computes cache_hit_rate correctly", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [{ name: "Bash" }], {
        input_tokens: 200,
        output_tokens: 100,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 0,
      }),
    ];
    const m = extractMetrics(entries, "s3");
    // cache_hit_rate = 800 / (200 + 800 + 0) = 0.8
    expect(m.overall_cache_hit_rate).toBeCloseTo(0.8, 4);
  });

  it("computes edit_precision as unique_files / total_edits", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [
        { name: "Edit", file_path: "/p/a.ts", old_string: "x", new_string: "y" },
        { name: "Edit", file_path: "/p/a.ts", old_string: "y", new_string: "z" },
      ]),
    ];
    const m = extractMetrics(entries, "s4");
    // 1 unique file, 2 total edits => precision = 0.5
    expect(m.edit_precision).toBeCloseTo(0.5, 4);
  });

  it("computes exploration_ratio correctly", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [
        { name: "Read", file_path: "/p/a.ts" },
        { name: "Read", file_path: "/p/b.ts" },
        { name: "Grep", file_path: "/p/c.ts" },
        { name: "Edit", file_path: "/p/a.ts", old_string: "a", new_string: "b" },
      ]),
    ];
    const m = extractMetrics(entries, "s5");
    // 3 exploration out of 4 total => 0.75
    expect(m.exploration_ratio).toBeCloseTo(0.75, 4);
  });

  it("includes cache_creation_input_tokens in max_context_tokens", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [], {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 5000,
      }),
    ];
    const m = extractMetrics(entries, "s6");
    // max_context = input + cache_read + cache_creation = 100 + 200 + 5000 = 5300
    expect(m.max_context_tokens).toBe(5300);
  });

  it("counts correction_count even in single-turn session", () => {
    const entries: SessionEntry[] = [
      userText("fix A", { timestamp: "2026-01-01T00:00:00Z" }),
      assistant("m1", [], {
        stop_reason: "end_turn",
        timestamp: "2026-01-01T00:00:01Z",
      }),
      userText("actually fix B", { timestamp: "2026-01-01T00:00:02Z" }),
    ];
    const m = extractMetrics(entries, "s7");
    expect(m.api_calls).toBe(1);
    expect(m.correction_count).toBe(1);
  });
});

describe("processEntry dedup", () => {
  it("does not double-count tool calls when same message processed twice (streaming)", () => {
    const live = createEmptyLiveMetrics("test");
    const entry = assistant("m1", [{ name: "Read", file_path: "/p/a.ts" }]);
    processEntry(entry, live);
    processEntry(entry, live); // simulate duplicate streaming event
    expect(live.turns).toBe(1);
    expect(live.total_tool_calls).toBe(1);
  });
});

describe("deduplicateEntries", () => {
  it("keeps only the last entry per message id", () => {
    const entries: SessionEntry[] = [
      assistant("m1", [{ name: "Read" }], { output_tokens: 100 }),
      assistant("m1", [{ name: "Read" }], { output_tokens: 200 }),
      assistant("m1", [{ name: "Read" }], { output_tokens: 300 }),
    ];
    const result = deduplicateEntries(entries);
    // Should keep only the last m1 entry
    const assistants = result.filter((e) => e.type === "assistant");
    expect(assistants).toHaveLength(1);
  });
});
