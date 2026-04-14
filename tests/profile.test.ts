import { describe, it, expect } from "vitest";
import { buildProfile } from "../src/profile.js";
import type { SessionEntry } from "../src/types.js";

function makeAssistantEntry(
  id: string,
  toolUseBlocks: { name: string; file_path?: string }[],
  opts?: {
    model?: string;
    stop_reason?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): SessionEntry {
  return {
    type: "assistant",
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      id,
      role: "assistant",
      model: opts?.model ?? "claude-sonnet-4-6",
      content: toolUseBlocks.map((b, i) => ({
        type: "tool_use" as const,
        id: `tu_${id}_${i}`,
        name: b.name,
        input: b.file_path ? { file_path: b.file_path } : {},
      })),
      usage: {
        input_tokens: opts?.input_tokens ?? 1000,
        output_tokens: opts?.output_tokens ?? 500,
        cache_read_input_tokens: opts?.cache_read_input_tokens ?? 800,
        cache_creation_input_tokens: opts?.cache_creation_input_tokens ?? 0,
      },
      stop_reason: opts?.stop_reason ?? "end_turn",
    },
  } as unknown as SessionEntry;
}

describe("buildProfile", () => {
  it("reports module with correct edit count from a single session", () => {
    const entries: SessionEntry[] = [
      makeAssistantEntry("msg1", [
        { name: "Read", file_path: "/project/src/api/handler.ts" },
        { name: "Edit", file_path: "/project/src/api/handler.ts" },
      ]),
      makeAssistantEntry("msg2", [
        { name: "Edit", file_path: "/project/src/api/handler.ts" },
      ]),
    ];

    const profile = buildProfile(
      [{ sessionId: "s1", entries, cwd: "/project" }],
      { depth: 2 },
    );

    const apiModule = profile.modules.find((m) => m.path === "src/api/");
    expect(apiModule).toBeDefined();
    expect(apiModule!.total_edits).toBe(2);
    expect(apiModule!.sessions_touched).toBe(1);
  });

  it("counts sessions_touched across two sessions for same module", () => {
    const entriesA: SessionEntry[] = [
      makeAssistantEntry("msgA", [
        { name: "Edit", file_path: "/project/src/api/handler.ts" },
      ]),
    ];
    const entriesB: SessionEntry[] = [
      makeAssistantEntry("msgB", [
        { name: "Edit", file_path: "/project/src/api/routes.ts" },
      ]),
    ];

    const profile = buildProfile(
      [
        { sessionId: "s1", entries: entriesA, cwd: "/project" },
        { sessionId: "s2", entries: entriesB, cwd: "/project" },
      ],
      { depth: 2 },
    );

    const apiModule = profile.modules.find((m) => m.path === "src/api/");
    expect(apiModule).toBeDefined();
    expect(apiModule!.sessions_touched).toBe(2);
  });

  it("produces different module paths at depth=1 vs depth=2", () => {
    const entries: SessionEntry[] = [
      makeAssistantEntry("msg1", [
        { name: "Edit", file_path: "/project/src/api/handler.ts" },
      ]),
    ];

    const p1 = buildProfile(
      [{ sessionId: "s1", entries, cwd: "/project" }],
      { depth: 1 },
    );
    const p2 = buildProfile(
      [{ sessionId: "s1", entries, cwd: "/project" }],
      { depth: 2 },
    );

    const paths1 = p1.modules.map((m) => m.path);
    const paths2 = p2.modules.map((m) => m.path);
    // depth=1 => "src/" ; depth=2 => "src/api/"
    expect(paths1).toContain("src/");
    expect(paths2).toContain("src/api/");
  });

  it("orders file_hotspots by total_edits descending", () => {
    const entries: SessionEntry[] = [
      makeAssistantEntry("msg1", [
        { name: "Edit", file_path: "/project/src/a.ts" },
        { name: "Edit", file_path: "/project/src/b.ts" },
      ]),
      makeAssistantEntry("msg2", [
        { name: "Edit", file_path: "/project/src/b.ts" },
        { name: "Edit", file_path: "/project/src/b.ts" },
      ]),
    ];

    const profile = buildProfile(
      [{ sessionId: "s1", entries, cwd: "/project" }],
      { depth: 2 },
    );

    expect(profile.file_hotspots.length).toBeGreaterThanOrEqual(2);
    // b.ts has 3 edits, a.ts has 1
    expect(profile.file_hotspots[0].path).toBe("src/b.ts");
    expect(profile.file_hotspots[0].total_edits).toBe(3);
  });

  it("returns empty result for empty sessions array", () => {
    const profile = buildProfile([]);
    expect(profile.total_sessions).toBe(0);
    expect(profile.modules).toHaveLength(0);
    expect(profile.file_hotspots).toHaveLength(0);
  });
});
