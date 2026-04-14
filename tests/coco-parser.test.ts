import { describe, it, expect } from "vitest";
import { translateCocoEvents } from "../src/coco-parser.js";
import type { CocoSessionMeta, CocoEvent } from "../src/coco-parser.js";
import type { AssistantEntry, ContentBlock } from "../src/types.js";

const META: CocoSessionMeta = {
  id: "sess-001",
  created_at: "2026-04-01T10:00:00Z",
  updated_at: "2026-04-01T10:05:00Z",
  metadata: {
    cwd: "/project",
    model_name: "codebase-internal",
    title: "test session",
    permission_mode: "default",
  },
};

function makeEvent(overrides: Partial<CocoEvent>): CocoEvent {
  return {
    id: "evt-" + Math.random().toString(36).slice(2, 8),
    session_id: "sess-001",
    branch: "main",
    agent_id: "agent-1",
    agent_name: "root-agent",
    parent_tool_call_id: "",
    created_at: "2026-04-01T10:00:01Z",
    ...overrides,
  };
}

describe("translateCocoEvents", () => {
  it("emits a permission-mode entry with session ID", () => {
    const entries = translateCocoEvents([], META);
    const pm = entries.find((e) => e.type === "permission-mode");
    expect(pm).toBeDefined();
    expect((pm as any).sessionId).toBe("sess-001");
  });

  it("translates user message to user entry", () => {
    const events: CocoEvent[] = [
      makeEvent({
        message: {
          message: {
            role: "user",
            content: "fix the bug",
          },
        },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const userEntries = entries.filter((e) => e.type === "user");
    expect(userEntries.length).toBeGreaterThanOrEqual(1);
    const user = userEntries[0] as any;
    expect(user.message.content).toBe("fix the bug");
  });

  it("skips additional_context_input user messages", () => {
    const events: CocoEvent[] = [
      makeEvent({
        message: {
          message: {
            role: "user",
            content: "system reminder",
            extra: { is_additional_context_input: true },
          },
        },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const userEntries = entries.filter(
      (e) => e.type === "user" && "message" in e && (e as any).message?.content === "system reminder"
    );
    expect(userEntries).toHaveLength(0);
  });

  it("translates assistant message with usage and tool_calls", () => {
    const events: CocoEvent[] = [
      makeEvent({
        id: "evt-assist-1",
        message: {
          message: {
            role: "assistant",
            content: "I'll read the file",
            tool_calls: [
              {
                id: "tc-1",
                type: "function",
                function: { name: "Read", arguments: '{"file_path":"/p/a.ts"}' },
              },
            ],
            response_meta: {
              finish_reason: "tool_use",
              usage: {
                prompt_tokens: 500,
                completion_tokens: 100,
                total_tokens: 600,
                prompt_token_details: { cached_tokens: 300 },
              },
            },
          },
        },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const assistants = entries.filter((e) => e.type === "assistant");
    expect(assistants).toHaveLength(1);

    const a = assistants[0] as AssistantEntry;
    expect(a.message.model).toBe("codebase-internal");
    expect(a.message.stop_reason).toBe("tool_use");

    // Usage: input_tokens = prompt_tokens - cached = 500 - 300 = 200
    expect(a.message.usage!.input_tokens).toBe(200);
    expect(a.message.usage!.output_tokens).toBe(100);
    expect(a.message.usage!.cache_read_input_tokens).toBe(300);
    expect(a.message.usage!.cache_creation_input_tokens).toBe(0);

    // Tool use content block
    const toolBlocks = a.message.content.filter((b) => b.type === "tool_use");
    expect(toolBlocks).toHaveLength(1);
    expect((toolBlocks[0] as any).name).toBe("Read");
  });

  it("maps finish_reason 'stop' to stop_reason 'end_turn'", () => {
    const events: CocoEvent[] = [
      makeEvent({
        message: {
          message: {
            role: "assistant",
            content: "Done!",
            response_meta: {
              finish_reason: "stop",
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            },
          },
        },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const a = entries.find((e) => e.type === "assistant") as AssistantEntry;
    expect(a.message.stop_reason).toBe("end_turn");
  });

  it("translates tool_call_output to user tool_result entry", () => {
    const events: CocoEvent[] = [
      makeEvent({
        tool_call_output: {
          tool_call_id: "tc-1",
          tool_info: { name: "Read" },
          output: { content: "file contents", is_error: false },
        },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const userEntries = entries.filter((e) => e.type === "user");
    // Should have a tool_result entry
    const toolResult = userEntries.find((e) => {
      const msg = (e as any).message;
      return Array.isArray(msg?.content) && msg.content.some((b: any) => b.type === "tool_result");
    });
    expect(toolResult).toBeDefined();
    const block = (toolResult as any).message.content[0];
    expect(block.tool_use_id).toBe("tc-1");
    expect(block.is_error).toBe(false);
  });

  it("translates tool_call_output with error", () => {
    const events: CocoEvent[] = [
      makeEvent({
        tool_call_output: {
          tool_call_id: "tc-2",
          tool_info: { name: "Bash" },
          output: { content: "command failed", is_error: true },
        },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const userEntries = entries.filter((e) => e.type === "user");
    const toolResult = userEntries.find((e) => {
      const msg = (e as any).message;
      return Array.isArray(msg?.content) && msg.content.some((b: any) => b.type === "tool_result");
    });
    expect(toolResult).toBeDefined();
    const block = (toolResult as any).message.content[0];
    expect(block.is_error).toBe(true);
  });

  it("translates compaction_end to system compact entry", () => {
    const events: CocoEvent[] = [
      makeEvent({
        compaction_end: { compacted: true },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const systemEntries = entries.filter((e) => e.type === "system");
    expect(systemEntries).toHaveLength(1);
    expect((systemEntries[0] as any).message).toBe("compact");
  });

  it("detects sidechain via agent_name != root agent", () => {
    const events: CocoEvent[] = [
      // Root agent starts
      makeEvent({
        agent_start: { input: [] },
        agent_name: "root-agent",
        parent_tool_call_id: "",
      }),
      // Root agent message — not sidechain
      makeEvent({
        agent_name: "root-agent",
        message: {
          message: {
            role: "assistant",
            content: "main chain",
            response_meta: {
              finish_reason: "end_turn",
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            },
          },
        },
      }),
      // Sub-agent message — sidechain
      makeEvent({
        agent_name: "sub-agent",
        parent_tool_call_id: "tc-parent",
        message: {
          message: {
            role: "assistant",
            content: "side chain",
            response_meta: {
              finish_reason: "end_turn",
              usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
            },
          },
        },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const assistants = entries.filter((e) => e.type === "assistant");
    expect(assistants).toHaveLength(2);

    // First assistant (root) — not sidechain
    expect((assistants[0] as any).isSidechain).toBe(false);
    // Second assistant (sub-agent) — sidechain
    expect((assistants[1] as any).isSidechain).toBe(true);
  });

  it("prefers structured_input from tool_call events for tool_use blocks", () => {
    const events: CocoEvent[] = [
      // tool_call event provides structured input
      makeEvent({
        tool_call: {
          tool_call_id: "tc-1",
          tool_info: { name: "Edit", annotations: { title: "Edit" } },
          input: {
            structured_input: { file_path: "/p/a.ts", old_string: "x", new_string: "y" },
          },
        },
      }),
      // assistant message references the tool_call
      makeEvent({
        message: {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tc-1",
                type: "function",
                function: { name: "edit_file", arguments: '{"raw":"ignored"}' },
              },
            ],
            response_meta: {
              finish_reason: "tool_use",
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            },
          },
        },
      }),
    ];

    const entries = translateCocoEvents(events, META);
    const a = entries.find((e) => e.type === "assistant") as AssistantEntry;
    const toolBlock = a.message.content.find((b) => b.type === "tool_use") as any;
    expect(toolBlock.name).toBe("Edit");
    expect(toolBlock.input.file_path).toBe("/p/a.ts");
  });
});
