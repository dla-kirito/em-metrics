import { watch, statSync, openSync, readSync, closeSync } from "fs";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { EventEmitter } from "events";
import { parseLine } from "./parser.js";
import type { SessionEntry } from "./types.js";

export interface WatcherEvents {
  entry: (entry: SessionEntry) => void;
  session_start: (sessionId: string, filePath: string) => void;
  session_end: () => void;
  error: (err: Error) => void;
}

/**
 * Watches a Claude Code session JSONL file for new entries in real-time.
 * Uses fs.watch + incremental read to tail the file.
 */
export class SessionWatcher extends EventEmitter {
  private filePath: string | null = null;
  private fd: number | null = null;
  private offset = 0;
  private watcher: ReturnType<typeof watch> | null = null;
  private buffer = "";
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Find the most recently modified .jsonl session file for a given project.
   */
  static async findLatestSession(cwd?: string): Promise<string | null> {
    const projectsDir = join(homedir(), ".claude", "projects");
    const cwdKey = (cwd ?? process.cwd()).replace(/\//g, "-");

    let targetDir: string | null = null;

    try {
      const dirs = await readdir(projectsDir);
      // Find project dir matching cwd
      for (const d of dirs) {
        if (d === cwdKey) {
          targetDir = join(projectsDir, d);
          break;
        }
      }

      // If no exact match, find any project dir
      if (!targetDir) {
        // Find most recently modified project dir
        let latest = 0;
        for (const d of dirs) {
          const dirPath = join(projectsDir, d);
          try {
            const s = await stat(dirPath);
            if (s.isDirectory() && s.mtimeMs > latest) {
              latest = s.mtimeMs;
              targetDir = dirPath;
            }
          } catch {}
        }
      }
    } catch {
      return null;
    }

    if (!targetDir) return null;

    // Find the most recently modified .jsonl file
    try {
      const files = await readdir(targetDir);
      let latestFile: string | null = null;
      let latestMtime = 0;

      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const fp = join(targetDir, f);
        try {
          const s = await stat(fp);
          if (s.mtimeMs > latestMtime) {
            latestMtime = s.mtimeMs;
            latestFile = fp;
          }
        } catch {}
      }

      return latestFile;
    } catch {
      return null;
    }
  }

  /**
   * Start watching a session file.
   * If no filePath provided, auto-detect the most recent active session.
   */
  async start(filePath?: string): Promise<void> {
    this.filePath =
      filePath ?? (await SessionWatcher.findLatestSession());

    if (!this.filePath) {
      this.emit("error", new Error("No active session found"));
      return;
    }

    const sessionId = basename(this.filePath, ".jsonl");
    this.emit("session_start", sessionId, this.filePath);

    // Read existing content first
    try {
      this.fd = openSync(this.filePath, "r");
      this.readNewData();
    } catch (err) {
      this.emit("error", err as Error);
      return;
    }

    // Watch for changes
    this.watcher = watch(this.filePath, (eventType) => {
      if (eventType === "change") {
        this.readNewData();
      }
    });

    // Also poll periodically as fs.watch can miss events on some OS/FS combos
    this.pollInterval = setInterval(() => {
      this.readNewData();
    }, 500);

    this.watcher.on("error", (err) => {
      this.emit("error", err);
    });
  }

  private readNewData(): void {
    if (!this.fd || !this.filePath) return;

    try {
      const fileSize = statSync(this.filePath).size;
      if (fileSize <= this.offset) return;

      const chunkSize = fileSize - this.offset;
      const buf = Buffer.alloc(chunkSize);
      const bytesRead = readSync(this.fd, buf, 0, chunkSize, this.offset);
      this.offset += bytesRead;

      const text = this.buffer + buf.toString("utf-8", 0, bytesRead);
      const lines = text.split("\n");

      // Keep incomplete last line in buffer
      this.buffer = lines.pop() ?? "";

      for (const line of lines) {
        const entry = parseLine(line);
        if (entry) {
          this.emit("entry", entry);
        }
      }
    } catch {
      // File might be temporarily locked
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
    this.emit("session_end");
  }
}
