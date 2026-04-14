import { createReadStream } from "fs";
import { createInterface } from "readline";
import type { AssistantEntry, SessionEntry } from "./types.js";

/**
 * Parse a session JSONL file and return all entries.
 */
export async function parseSessionFile(
  filePath: string
): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Parse a single JSONL line into a session entry.
 */
export function parseLine(line: string): SessionEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Check if an entry is an assistant message with usage data.
 */
export function isAssistantWithUsage(
  entry: SessionEntry
): entry is AssistantEntry {
  return (
    entry.type === "assistant" &&
    "message" in entry &&
    !!(entry as AssistantEntry).message?.usage
  );
}

/**
 * Check if an entry is a transcript message (user/assistant/system/etc.)
 */
export function isTranscriptMessage(entry: SessionEntry): boolean {
  const types = new Set(["user", "assistant", "attachment", "system", "progress"]);
  return types.has(entry.type);
}
