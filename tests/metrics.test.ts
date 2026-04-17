import { describe, it, expect } from "vitest";
import {
  extractMetrics,
  deduplicateEntries,
  processEntry,
  parseMcpToolName,
  computeShotBucket,
  normalizeFileExt,
  countCacheBreaks,
  isRejectionResult,
} from "../src/metrics.js";
import type { SessionEntry, TurnMetrics } from "../src/types.js";
import { createEmptyLiveMetrics } from "../src/types.js";
import { assistant, assistantWithBlocks, toolResults, userText } from "./helpers.js";

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
    expect(m.tool_breakdown["Read"]).toEqual({ count: 1, errors: 0, rejections: 0 });
    expect(m.tool_breakdown["Edit"]).toEqual({ count: 1, errors: 0, rejections: 0 });
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

describe("parseMcpToolName", () => {
  it("returns null for non-MCP tools", () => {
    expect(parseMcpToolName("Read")).toBeNull();
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("mcp__github")).toBeNull();
  });

  it("parses standard MCP tool names", () => {
    expect(parseMcpToolName("mcp__github__create_issue")).toEqual({
      server: "github",
      tool: "create_issue",
    });
    expect(parseMcpToolName("mcp__pencil__batch_get")).toEqual({
      server: "pencil",
      tool: "batch_get",
    });
  });

  it("preserves double-underscore segments inside the tool name", () => {
    // Server names are single segment; double underscores in tool names are rejoined.
    expect(parseMcpToolName("mcp__server__with__more__underscores")).toEqual({
      server: "server",
      tool: "with__more__underscores",
    });
  });
});

describe("computeShotBucket", () => {
  it("bucketizes turn counts aligned with monitoring doc", () => {
    expect(computeShotBucket(0)).toBe("1");
    expect(computeShotBucket(1)).toBe("1");
    expect(computeShotBucket(2)).toBe("2-4");
    expect(computeShotBucket(4)).toBe("2-4");
    expect(computeShotBucket(5)).toBe("5-10");
    expect(computeShotBucket(10)).toBe("5-10");
    expect(computeShotBucket(11)).toBe("10+");
    expect(computeShotBucket(100)).toBe("10+");
  });
});

describe("one-shot and MCP aggregation", () => {
  it("flags one_shot when single mainchain turn ends with end_turn", () => {
    const entries: SessionEntry[] = [
      userText("hi"),
      assistant("m1", [], { stop_reason: "end_turn" }),
    ];
    const m = extractMetrics(entries, "s-oneshot");
    expect(m.mainchain_turns).toBe(1);
    expect(m.one_shot).toBe(true);
    expect(m.shot_bucket).toBe("1");
  });

  it("does not flag one_shot when stop_reason is tool_use", () => {
    const entries: SessionEntry[] = [
      userText("hi"),
      assistant("m1", [{ name: "Read", file_path: "/a" }], { stop_reason: "tool_use" }),
    ];
    const m = extractMetrics(entries, "s-notoneshot");
    expect(m.one_shot).toBe(false);
  });

  it("aggregates MCP tool calls and server names", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [
        { name: "mcp__github__create_issue" },
        { name: "mcp__github__list_prs" },
        { name: "mcp__pencil__batch_get" },
        { name: "Read", file_path: "/a" },
      ]),
    ];
    const m = extractMetrics(entries, "s-mcp");
    expect(m.mcp_tool_calls).toBe(3);
    expect(m.mcp_servers_used).toEqual(["github", "pencil"]);
  });
});

describe("normalizeFileExt", () => {
  it("returns lowercase extension for standard files", () => {
    expect(normalizeFileExt("/a/b/foo.ts")).toBe(".ts");
    expect(normalizeFileExt("Foo.TS")).toBe(".ts");
    expect(normalizeFileExt("bar.py")).toBe(".py");
  });

  it("handles .d.ts as compound extension", () => {
    expect(normalizeFileExt("types/foo.d.ts")).toBe(".d.ts");
  });

  it("returns lowercase basename for well-known extensionless filenames", () => {
    expect(normalizeFileExt("/p/Makefile")).toBe("makefile");
    expect(normalizeFileExt("Dockerfile")).toBe("dockerfile");
    expect(normalizeFileExt("README")).toBe("readme");
  });

  it("treats dotfiles as their own extension", () => {
    expect(normalizeFileExt(".gitignore")).toBe(".gitignore");
    expect(normalizeFileExt("/p/.env")).toBe(".env");
  });

  it("returns (none) for bare names", () => {
    expect(normalizeFileExt("LICENSE_TEXT")).toBe("(none)");
  });
});

describe("countCacheBreaks", () => {
  const mkTurn = (cacheRead: number, isSidechain = false): TurnMetrics => ({
    turn_index: 0,
    timestamp: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: 0,
    cache_hit_rate: 0,
    tool_calls: [],
    has_tool_error: false,
    stop_reason: "",
    is_sidechain: isSidechain,
    inter_turn_gap_ms: 0,
  });

  it("skips the first turn (cold start)", () => {
    expect(countCacheBreaks([mkTurn(0), mkTurn(100)])).toBe(0);
  });

  it("detects read>0 followed by read===0", () => {
    expect(countCacheBreaks([mkTurn(100), mkTurn(0), mkTurn(100)])).toBe(1);
  });

  it("excludes sidechain turns from the analysis", () => {
    expect(
      countCacheBreaks([mkTurn(100), mkTurn(0, true), mkTurn(100)])
    ).toBe(0);
  });

  it("counts multiple breaks", () => {
    expect(
      countCacheBreaks([mkTurn(100), mkTurn(0), mkTurn(100), mkTurn(0)])
    ).toBe(2);
  });
});

describe("isRejectionResult", () => {
  it("matches the Claude Code rejection sentinel", () => {
    expect(
      isRejectionResult(
        "The user doesn't want to proceed with this tool use. The tool use was rejected."
      )
    ).toBe(true);
  });

  it("does not match generic tool errors", () => {
    expect(isRejectionResult("Error: command not found")).toBe(false);
    expect(isRejectionResult("")).toBe(false);
  });

  it("walks arrays of text blocks", () => {
    expect(
      isRejectionResult([{ type: "text", text: "tool use was rejected" }])
    ).toBe(true);
  });
});

describe("P1 metric wiring", () => {
  it("populates output/thinking char counts and message_count", () => {
    const entries: SessionEntry[] = [
      userText("hi"),
      assistantWithBlocks("m1", [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hello world" },
      ]),
    ];
    const m = extractMetrics(entries, "s-chars");
    expect(m.output_chars_total).toBe("hello world".length);
    expect(m.thinking_chars_total).toBe("hmm".length);
    expect(m.message_count).toBe(2); // one user + one assistant
  });

  it("tracks tool_rejections separately from tool_errors", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [{ name: "Bash", command: "rm -rf /" }]),
      toolResults([{ tool_use_id: "m1_tu0", rejected: true }]),
    ];
    const m = extractMetrics(entries, "s-reject");
    expect(m.tool_rejections).toBe(1);
    expect(m.tool_errors).toBe(1); // rejection is also an is_error
    // per-tool breakdown puts it under rejections, not errors
    expect(m.tool_breakdown["Bash"]).toEqual({ count: 1, errors: 0, rejections: 1 });
  });

  it("keeps runtime errors and rejections separate in tool_breakdown", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [{ name: "Bash", command: "false" }]),
      toolResults([{ tool_use_id: "m1_tu0", is_error: true }]),
    ];
    const m = extractMetrics(entries, "s-err");
    expect(m.tool_breakdown["Bash"]).toEqual({ count: 1, errors: 1, rejections: 0 });
  });

  it("aggregates server_tool_usage across turns", () => {
    const entries: SessionEntry[] = [
      userText("search"),
      assistantWithBlocks("m1", [{ type: "text", text: "done" }], {
        server_tool_use: { web_search_requests: 2 },
      }),
      userText("more"),
      assistantWithBlocks("m2", [{ type: "text", text: "done2" }], {
        server_tool_use: { web_search_requests: 3 },
      }),
    ];
    const m = extractMetrics(entries, "s-server");
    expect(m.server_tool_usage.web_search_requests).toBe(5);
  });

  it("builds file_ext_distribution from edited files", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [
        { name: "Write", file_path: "/p/a.ts" },
        { name: "Write", file_path: "/p/b.ts" },
        { name: "Write", file_path: "/p/Makefile" },
      ]),
    ];
    const m = extractMetrics(entries, "s-ext");
    expect(m.file_ext_distribution[".ts"]).toBe(2);
    expect(m.file_ext_distribution.makefile).toBe(1);
  });

  it("records model_usage keyed by model id", () => {
    const entries: SessionEntry[] = [
      userText("hi"),
      assistantWithBlocks("m1", [{ type: "text", text: "a" }], {
        model: "claude-sonnet-4-6",
        input_tokens: 100,
        output_tokens: 50,
      }),
      userText("more"),
      assistantWithBlocks("m2", [{ type: "text", text: "b" }], {
        model: "claude-opus-4-7",
        input_tokens: 200,
        output_tokens: 80,
      }),
    ];
    const m = extractMetrics(entries, "s-models");
    expect(Object.keys(m.model_usage).sort()).toEqual([
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
    expect(m.model_usage["claude-opus-4-7"].calls).toBe(1);
    expect(m.model_usage["claude-opus-4-7"].input_tokens).toBe(200);
  });

  it("samples tool_use and tool_result char sizes", () => {
    const entries: SessionEntry[] = [
      userText("go"),
      assistant("m1", [{ name: "Read", file_path: "/a" }]),
      toolResults([{ tool_use_id: "m1_tu0", text: "12345" }]),
    ];
    const m = extractMetrics(entries, "s-sizes");
    expect(m.tool_use_chars_p50).toBeGreaterThan(0);
    expect(m.tool_result_chars_p50).toBe(5);
  });
});
