/**
 * Coco session parser — translates Coco's event-based session format
 * into Claude Code's SessionEntry[] for reuse with extractMetrics().
 *
 * Coco sessions live in ~/Library/Caches/coco/sessions/<session-id>/
 *   - session.json: metadata (id, cwd, model, title)
 *   - events.jsonl: event stream (message, tool_call, tool_call_output, etc.)
 */

import { createReadStream } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { createInterface } from "readline";
import { join } from "path";
import { homedir, platform } from "os";
import type { SessionEntry, AssistantEntry, ContentBlock } from "./types.js";

// ── Coco types (internal) ───────────────────────────────────────

export interface CocoSessionMeta {
  id: string;
  created_at: string;
  updated_at: string;
  metadata: {
    cwd?: string;
    model_name?: string;
    title?: string;
    permission_mode?: string;
    runtime?: string;
  };
}

export interface CocoEvent {
  id: string;
  session_id: string;
  branch: string;
  agent_id: string;
  agent_name: string;
  parent_tool_call_id: string;
  created_at: string;
  message?: { message: CocoMessage };
  tool_call?: CocoToolCall;
  tool_call_output?: CocoToolCallOutput;
  state_update?: { updates: Record<string, unknown> };
  compaction_start?: Record<string, never>;
  compaction_end?: { compacted: boolean; error_message?: string };
  agent_start?: { input?: unknown[] };
  agent_end?: { output?: unknown; error_message?: string };
  rewind?: unknown;
}

interface CocoMessage {
  role: string;
  content: string | unknown[];
  tool_calls?: CocoInlineToolCall[];
  response_meta?: {
    finish_reason?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_token_details?: { cached_tokens?: number };
      completion_token_details?: Record<string, unknown>;
    };
  };
  extra?: {
    is_original_user_input?: boolean;
    is_additional_context_input?: boolean;
  };
}

interface CocoInlineToolCall {
  id: string;
  type: string; // "function"
  function: { name: string; arguments: string };
  extra?: { is_programmatic?: boolean };
}

interface CocoToolCall {
  tool_call_id: string;
  tool_info?: { annotations?: { title?: string }; name?: string };
  is_programmatic?: boolean;
  input?: {
    input?: string;
    structured_input?: Record<string, unknown>;
  };
}

interface CocoToolCallOutput {
  tool_call_id: string;
  tool_info?: { annotations?: { title?: string }; name?: string };
  is_programmatic?: boolean;
  input?: {
    input?: string;
    structured_input?: Record<string, unknown>;
  };
  output?: {
    content?: unknown;
    structured_content?: unknown;
    is_error?: boolean;
  };
}

export interface CocoSessionInfo {
  sessionId: string;
  sessionDir: string;
  meta: CocoSessionMeta;
}

// ── Session discovery ───────────────────────────────────────────

function getCocoSessionsDir(): string {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Caches", "coco", "sessions");
  }
  // Linux
  return join(homedir(), ".cache", "coco", "sessions");
}

/**
 * Find all coco sessions, optionally filtered by cwd and date range.
 */
export async function findCocoSessions(opts?: {
  cwd?: string;
  since?: string;
  until?: string;
}): Promise<CocoSessionInfo[]> {
  const sessionsDir = getCocoSessionsDir();
  let dirs: string[];
  try {
    dirs = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const results: CocoSessionInfo[] = [];

  for (const d of dirs) {
    const sessionDir = join(sessionsDir, d);
    const metaPath = join(sessionDir, "session.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta: CocoSessionMeta = JSON.parse(raw);

      // Date filtering (use updated_at from metadata)
      const dateStr = (meta.updated_at || meta.created_at || "").slice(0, 10);
      if (opts?.since && dateStr < opts.since) continue;
      if (opts?.until && dateStr > opts.until) continue;

      // CWD filtering
      if (opts?.cwd && meta.metadata?.cwd) {
        if (!meta.metadata.cwd.startsWith(opts.cwd)) continue;
      }

      results.push({ sessionId: meta.id, sessionDir, meta });
    } catch {
      // Skip invalid sessions
    }
  }

  // Sort by date, most recent first
  results.sort((a, b) => {
    const da = a.meta.updated_at || a.meta.created_at || "";
    const db = b.meta.updated_at || b.meta.created_at || "";
    return db.localeCompare(da);
  });

  return results;
}

/**
 * Find the most recent coco session.
 */
export async function findLatestCocoSession(): Promise<CocoSessionInfo | null> {
  const sessions = await findCocoSessions();
  return sessions[0] ?? null;
}

// ── Event parsing ───────────────────────────────────────────────

async function readCocoEvents(sessionDir: string): Promise<CocoEvent[]> {
  const eventsPath = join(sessionDir, "events.jsonl");
  const events: CocoEvent[] = [];
  const rl = createInterface({
    input: createReadStream(eventsPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

// ── Event translation ───────────────────────────────────────────

/**
 * Translate coco events into Claude Code SessionEntry[] format.
 * This allows reuse of extractMetrics() without modification.
 */
export function translateCocoEvents(
  events: CocoEvent[],
  meta: CocoSessionMeta
): SessionEntry[] {
  const entries: SessionEntry[] = [];

  // Determine the root agent name (first agent_start event's agent_name, or from branch)
  const rootAgentName = findRootAgent(events);

  // Build a map of tool_call_id → tool name from tool_call events
  const toolNameMap = new Map<string, string>();
  const toolInputMap = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    if (e.tool_call) {
      const name = e.tool_call.tool_info?.annotations?.title
        ?? e.tool_call.tool_info?.name
        ?? "unknown";
      toolNameMap.set(e.tool_call.tool_call_id, name);
      // Extract structured input
      const si = e.tool_call.input?.structured_input;
      if (si) {
        toolInputMap.set(e.tool_call.tool_call_id, si);
      }
    }
    if (e.tool_call_output) {
      const name = e.tool_call_output.tool_info?.annotations?.title
        ?? e.tool_call_output.tool_info?.name;
      if (name) toolNameMap.set(e.tool_call_output.tool_call_id, name);
      const si = e.tool_call_output.input?.structured_input;
      if (si) {
        toolInputMap.set(e.tool_call_output.tool_call_id, si);
      }
    }
  }

  // Emit a synthetic permission-mode entry for session ID
  entries.push({
    type: "permission-mode",
    permissionMode: meta.metadata?.permission_mode ?? "default",
    sessionId: meta.id,
    timestamp: meta.created_at,
  } as any);

  for (const e of events) {
    const isSidechain = !!rootAgentName && e.agent_name !== rootAgentName && e.agent_name !== "";
    const timestamp = e.created_at;

    // ── User messages ──
    if (e.message?.message?.role === "user") {
      const msg = e.message.message;
      // Skip additional context injections (system reminders, etc.)
      if (msg.extra?.is_additional_context_input) continue;

      entries.push({
        type: "user",
        timestamp,
        isSidechain,
        message: {
          role: "user",
          content: typeof msg.content === "string" ? msg.content : msg.content as any,
        },
      } as any);
    }

    // ── Assistant messages ──
    if (e.message?.message?.role === "assistant") {
      const msg = e.message.message;
      const responseMeta = msg.response_meta;
      const usage = responseMeta?.usage;

      // Build content blocks
      const contentBlocks: ContentBlock[] = [];

      // Text content
      if (typeof msg.content === "string" && msg.content.length > 0) {
        contentBlocks.push({ type: "text", text: msg.content });
      }

      // Inline tool_calls → tool_use content blocks
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const toolName = toolNameMap.get(tc.id) ?? tc.function.name;
          let input: Record<string, unknown> = {};
          // Prefer structured_input from tool_call event
          const si = toolInputMap.get(tc.id);
          if (si) {
            input = si;
          } else {
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              input = { raw: tc.function.arguments };
            }
          }
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: toolName,
            input,
          });
        }
      }

      // Map usage fields
      const cachedTokens = usage?.prompt_token_details?.cached_tokens ?? 0;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const completionTokens = usage?.completion_tokens ?? 0;

      // Map finish_reason → stop_reason
      let stopReason = responseMeta?.finish_reason ?? "";
      if (stopReason === "tool_use") stopReason = "tool_use";
      else if (stopReason === "stop" || stopReason === "end_turn") stopReason = "end_turn";

      // Determine model name
      const model = meta.metadata?.model_name ?? "unknown";

      const assistantEntry: AssistantEntry = {
        type: "assistant",
        timestamp,
        isSidechain,
        message: {
          id: e.id,
          role: "assistant",
          model,
          content: contentBlocks,
          usage: {
            input_tokens: Math.max(0, promptTokens - cachedTokens),
            output_tokens: completionTokens,
            cache_read_input_tokens: cachedTokens,
            cache_creation_input_tokens: 0, // Coco doesn't report this
          },
          stop_reason: stopReason,
        },
      };

      entries.push(assistantEntry);
    }

    // ── Tool call outputs → tool_result entries ──
    if (e.tool_call_output) {
      const tco = e.tool_call_output;
      const isError = tco.output?.is_error ?? false;
      const toolResultBlock: ContentBlock = {
        type: "tool_result",
        tool_use_id: tco.tool_call_id,
        is_error: isError,
      };

      entries.push({
        type: "user",
        timestamp,
        isSidechain,
        message: {
          role: "user",
          content: [toolResultBlock],
        },
      } as any);
    }

    // ── Compaction ──
    if (e.compaction_end) {
      entries.push({
        type: "system",
        timestamp,
        message: "compact",
      } as any);
    }
  }

  return entries;
}

/**
 * Find the root agent name from events (first agent that isn't a sub-agent).
 */
function findRootAgent(events: CocoEvent[]): string {
  // The root agent is the one with no parent_tool_call_id in agent_start
  for (const e of events) {
    if (e.agent_start && !e.parent_tool_call_id) {
      return e.agent_name;
    }
  }
  // Fallback: use the first event's agent_name
  for (const e of events) {
    if (e.agent_name) return e.agent_name;
  }
  return "";
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Parse a coco session directory into SessionEntry[] (Claude Code compatible).
 */
export async function parseCocoSession(sessionDir: string): Promise<{
  entries: SessionEntry[];
  sessionId: string;
  metadata: CocoSessionMeta;
}> {
  const metaRaw = await readFile(join(sessionDir, "session.json"), "utf-8");
  const metadata: CocoSessionMeta = JSON.parse(metaRaw);
  const events = await readCocoEvents(sessionDir);
  const entries = translateCocoEvents(events, metadata);

  return {
    entries,
    sessionId: metadata.id,
    metadata,
  };
}
