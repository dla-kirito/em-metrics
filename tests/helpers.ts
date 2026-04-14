/**
 * Shared test helpers for creating mock session entries.
 */

import type { SessionEntry } from "../src/types.js";

/** Create an assistant entry with tool_use blocks. */
export function assistant(
  id: string,
  tools: { name: string; file_path?: string; command?: string; old_string?: string; new_string?: string }[],
  opts?: {
    stop_reason?: string;
    timestamp?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): SessionEntry {
  return {
    type: "assistant",
    timestamp: opts?.timestamp ?? "2026-01-01T00:00:01Z",
    message: {
      id,
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: tools.map((t, i) => ({
        type: "tool_use" as const,
        id: `${id}_tu${i}`,
        name: t.name,
        input: {
          ...(t.file_path ? { file_path: t.file_path } : {}),
          ...(t.command ? { command: t.command } : {}),
          ...(t.old_string !== undefined ? { old_string: t.old_string } : {}),
          ...(t.new_string !== undefined ? { new_string: t.new_string } : {}),
        },
      })),
      usage: {
        input_tokens: opts?.input_tokens ?? 1000,
        output_tokens: opts?.output_tokens ?? 200,
        cache_read_input_tokens: opts?.cache_read_input_tokens ?? 800,
        cache_creation_input_tokens: opts?.cache_creation_input_tokens ?? 0,
      },
      stop_reason: opts?.stop_reason ?? "tool_use",
    },
  } as unknown as SessionEntry;
}

/** Create a user entry with tool_result blocks. */
export function toolResults(
  results: { tool_use_id: string; is_error?: boolean }[],
  opts?: { timestamp?: string },
): SessionEntry {
  return {
    type: "user",
    timestamp: opts?.timestamp ?? "2026-01-01T00:00:02Z",
    message: {
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.is_error ? "Error: something went wrong" : "OK",
        is_error: !!r.is_error,
      })),
    },
  } as unknown as SessionEntry;
}

/** Create a user text entry. */
export function userText(
  text: string,
  opts?: { timestamp?: string },
): SessionEntry {
  return {
    type: "user",
    timestamp: opts?.timestamp ?? "2026-01-01T00:00:00Z",
    message: {
      role: "user",
      content: text,
    },
  } as unknown as SessionEntry;
}
