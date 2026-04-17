// Types for eval-metrics

/** Per-turn fine-grained metrics */
export interface TurnMetrics {
  turn_index: number;
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_hit_rate: number;       // cache_read / (cache_read + cache_creation + input)
  tool_calls: string[];         // tool names used in this turn
  has_tool_error: boolean;
  stop_reason: string;
  is_sidechain: boolean;
  inter_turn_gap_ms: number;    // gap since previous turn (includes user idle)
}

export interface EvalSessionMetrics {
  session_id: string;
  model: string;
  started_at: string;
  ended_at: string;
  wall_duration_ms: number;
  active_duration_ms: number;   // wall minus long idle gaps (>30s)

  // Token usage
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  overall_cache_hit_rate: number; // aggregate cache hit rate

  // API performance
  api_calls: number;              // = mainchain_turns; one assistant message on the main chain
  api_retries: number;

  // Tool usage
  total_tool_calls: number;
  tool_breakdown: Record<string, { count: number; errors: number; rejections: number }>;
  mcp_tool_calls: number;                 // tool calls whose name starts with "mcp__"
  mcp_servers_used: string[];             // sorted list of MCP server names seen

  // Code changes
  lines_added: number;
  lines_removed: number;
  files_changed: string[];

  // Context
  compact_count: number;
  max_context_tokens: number;

  // Result
  stop_reason: string;

  // Per-turn detail
  turns_detail: TurnMetrics[];
  cache_hit_rate_trend: number[]; // per-turn cache hit rate series

  // Sidechain stats
  sidechain_turns: number;
  mainchain_turns: number;

  // Shot (Tier 1 core)
  one_shot: boolean;                      // mainchain_turns===1 && stop_reason==="end_turn"
  shot_bucket: "1" | "2-4" | "5-10" | "10+";  // bucket aligned with monitoring doc

  // Cost
  cost_usd: number;

  // User interaction quality
  user_messages: number;          // total user messages
  user_turns: number;             // user messages with real text (not tool_result)
  tool_rejections: number;        // user rejected tool calls
  tool_errors: number;            // tool calls that returned errors
  correction_count: number;       // user follow-ups after agent said end_turn (real corrections)
  files_re_edited: number;        // Edit calls to same file_path (rework)
  abandonment: boolean;           // session ended abnormally (not end_turn, not tool_use)

  // Token efficiency
  tokens_per_loc: number | null;     // output_tokens / (lines_added + lines_removed)
  tool_success_rate: number;         // 1 - (tool_errors / total_tool_calls)
  exploration_ratio: number;         // (Read+Grep+Glob) / total_tool_calls
  edit_precision: number;            // unique_files_edited / total_edit_calls (1.0 = no rework)

  // Output structure (P1 — per monitoring doc §1 "输出结构")
  // Note: *_chars fields are UTF-16 code units (JS `.length`), not bytes.
  message_count: number;             // user + assistant entries after dedup
  output_chars_total: number;        // sum of assistant text block char counts
  thinking_chars_total: number;      // sum of thinking block char counts
  tool_use_chars_p50: number;        // per tool_use input JSON.stringify length
  tool_use_chars_p90: number;
  tool_result_chars_p50: number;     // per user tool_result content char count
  tool_result_chars_p90: number;

  // Distributions & breakdowns
  file_ext_distribution: Record<string, number>;  // normalized ext → edit+write count
  server_tool_usage: Record<string, number>;      // e.g. {web_search_requests: N}
  model_usage: Record<string, { calls: number; input_tokens: number; output_tokens: number }>;

  // Events
  cache_break_count: number;         // mainchain transitions cache_read>0 → cache_read===0

  // Session context
  permission_mode: string;           // last observed permission mode ("" if absent)
}

// Raw JSONL entry types (matching Claude Code's session format)

export interface BaseEntry {
  type: string;
  timestamp?: string;
  isSidechain?: boolean;
}

export interface PermissionModeEntry extends BaseEntry {
  type: "permission-mode";
  permissionMode: string;
  sessionId: string;
}

export interface UserEntry extends BaseEntry {
  type: "user";
  message: {
    role: "user";
    content: string | ContentBlock[];
  };
}

export interface AssistantEntry extends BaseEntry {
  type: "assistant";
  message: {
    id?: string;
    role: "assistant";
    model?: string;
    content: ContentBlock[];
    usage?: Usage;
    stop_reason?: string;
  };
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: string | ContentBlock[]; is_error?: boolean }
  | { type: "image"; source: unknown };

export type SessionEntry = PermissionModeEntry | UserEntry | AssistantEntry | BaseEntry;

// Live metrics (accumulating during watch)
export interface LiveMetrics {
  session_id: string;
  model: string;
  started_at: string | null;
  duration_ms: number;
  turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  max_context_tokens: number;
  tool_calls: Record<string, { count: number; errors: number; rejections: number }>;
  total_tool_calls: number;
  lines_added: number;
  lines_removed: number;
  files_changed: Set<string>;
  compact_count: number;
  last_tool: string | null;
  last_tool_args: string | null;
  stop_reason: string;
  is_running: boolean;
  /** Track processed message IDs to deduplicate streaming entries */
  seen_message_ids: Set<string>;

  // Per-turn collection
  turns_detail: TurnMetrics[];
  /** Timestamp of last assistant entry, for computing inter-turn gap */
  last_turn_timestamp: string | null;
  /** Current turn's tool calls being accumulated */
  current_turn_tools: string[];
  /** Current turn has tool error */
  current_turn_has_error: boolean;
  /** Sidechain turn count */
  sidechain_turns: number;
  /** MCP tool call count (tools whose name starts with "mcp__") */
  mcp_tool_calls: number;
  /** Set of MCP server names seen */
  mcp_servers_used: Set<string>;

  // Output structure accumulators (P1)
  message_count: number;
  output_chars_total: number;
  thinking_chars_total: number;
  /** Per-call sample buckets — percentiles computed in liveToFinal */
  tool_use_chars_samples: number[];
  tool_result_chars_samples: number[];

  // Distributions (P1)
  server_tool_usage: Record<string, number>;
  model_usage: Record<string, { calls: number; input_tokens: number; output_tokens: number }>;

  // Session context (P1)
  permission_mode: string;

  // User interaction tracking
  user_messages: number;
  user_turns: number;
  tool_rejections: number;
  tool_errors: number;
  correction_count: number;
  /** Track which files have been edited, for re-edit detection */
  edit_file_counts: Map<string, number>;
  /** Was the last entry type assistant? (for correction detection) */
  last_entry_was_assistant: boolean;
  /** Last assistant stop_reason — used to detect real corrections (user follows up after end_turn) */
  last_stop_reason: string;
}

// ── Eval Framework Types ─────────────────────────────────────

/** 评测任务定义（从 YAML 加载） */
export interface EvalTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  setup?: string[];
  teardown?: string[];
  graders: GraderConfig[];
  model?: string;
  max_budget_usd?: number;
  timeout_s?: number;
  allowed_tools?: string[];
  system_prompt?: string;
  tags?: string[];
  trials?: number;
  difficulty?: "easy" | "medium" | "hard";
  capability?: string;  // e.g. "bug-fix", "refactor", "new-feature"

  /** Session source: "claude" (default) or "coco". Controls binary, args, and session parsing. */
  source?: "claude" | "coco";
  /** Custom binary path. Defaults to "claude" or "coco" based on source. */
  binary?: string;
  /** Multi-turn prompts: each entry is a separate session invocation.
   *  When specified, `prompt` is used for the final (graded) session only. */
  prompts?: string[];
}

/** 评分器配置 */
export type GraderConfig = CodeGraderConfig | LLMGraderConfig;

export interface CodeGraderConfig {
  type: "code";
  name: string;
  check: "file_exists" | "file_contains" | "command" | "file_not_contains";
  path?: string;
  pattern?: string;
  command?: string;
}

export interface LLMGraderConfig {
  type: "llm";
  name: string;
  prompt: string;
  model?: string;
  threshold?: number;
}

/** 单次试验结果 */
export interface TrialResult {
  task_id: string;
  trial_index: number;
  session_id: string;
  metrics: EvalSessionMetrics;
  grader_results: GraderResult[];
  passed: boolean;
  score: number;
  error?: string;
  transcript_path: string;
}

/** 评分结果 */
export interface GraderResult {
  name: string;
  type: "code" | "llm";
  passed: boolean;
  score: number;
  detail: string;
}

/** 评测聚合结果（跨多次 trial） */
export interface EvalResult {
  task_id: string;
  task_name: string;
  model: string;
  trials: TrialResult[];
  pass_at_k: number;
  pass_pow_k: number;
  pass_rate: number;
  avg_score: number;
  avg_turns: number;
  avg_tokens: number;
  avg_duration_ms: number;
  avg_cost_usd: number;
  tags?: string[];
  difficulty?: string;
  capability?: string;
  flakiness: number;  // 0=stable, 1=maximally flaky (pass_rate near 50%)
}

// ── Trace Types ─────────────────────────────────────────────

export interface TraceOutput {
  session_id: string;
  model: string;
  started_at: string;
  wall_duration_ms: number;
  cost_usd: number;
  user_prompt: string;
  total_steps: number;
  steps: TraceStep[];
  signals: TraceSignal[];
}

export interface TraceStep {
  index: number;
  type: "user_text" | "tool_call" | "tool_result" | "assistant_text" | "thinking";
  timestamp: string;
  is_sidechain: boolean;

  // user_text
  text?: string;

  // tool_call
  tool_name?: string;
  tool_arg?: string;
  tool_id?: string;
  output_tokens?: number;
  cache_hit_rate?: number;

  // tool_result
  tool_use_id?: string;
  is_error?: boolean;
  result_preview?: string;

  // assistant_text / thinking
  assistant_text?: string;
}

export interface TraceSignal {
  type: string;
  step_range: [number, number];
  description: string;
}

// ── Profile Types ───────────────────────────────────────────

export interface ProfileOutput {
  period: { since: string; until: string };
  total_sessions: number;
  total_cost_usd: number;
  modules: ModuleProfile[];
  file_hotspots: FileHotspot[];
}

export interface ModuleProfile {
  path: string;
  sessions_touched: number;
  total_edits: number;
  total_reads: number;
  re_edit_rate: number;
  session_correction_rate: number;
  session_abandonment_rate: number;
  avg_cost_usd: number;
}

export interface FileHotspot {
  path: string;
  total_edits: number;
  sessions_count: number;
  re_edit_sessions: number;
}

// ── Patterns Types ──────────────────────────────────────────

export interface PatternsOutput {
  period: { since: string; until: string };
  total_sessions: number;
  anti_patterns: PatternEntry[];
  effective_patterns: PatternEntry[];
}

export interface PatternEntry {
  id: string;
  name: string;
  description: string;
  occurrences: number;
  affected_pct: number;
  example_sessions: string[];
  typical_sequence: string[];
}

// ── Live Metrics ─────────────────────────────────────────────

export function createEmptyLiveMetrics(sessionId: string): LiveMetrics {
  return {
    session_id: sessionId,
    model: "unknown",
    started_at: null,
    duration_ms: 0,
    turns: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    max_context_tokens: 0,
    tool_calls: {},
    total_tool_calls: 0,
    lines_added: 0,
    lines_removed: 0,
    files_changed: new Set(),
    compact_count: 0,
    last_tool: null,
    last_tool_args: null,
    stop_reason: "",
    is_running: true,
    seen_message_ids: new Set(),
    turns_detail: [],
    last_turn_timestamp: null,
    current_turn_tools: [],
    current_turn_has_error: false,
    sidechain_turns: 0,
    mcp_tool_calls: 0,
    mcp_servers_used: new Set(),
    message_count: 0,
    output_chars_total: 0,
    thinking_chars_total: 0,
    tool_use_chars_samples: [],
    tool_result_chars_samples: [],
    server_tool_usage: {},
    model_usage: {},
    permission_mode: "",
    user_messages: 0,
    user_turns: 0,
    tool_rejections: 0,
    tool_errors: 0,
    correction_count: 0,
    edit_file_counts: new Map(),
    last_entry_was_assistant: false,
    last_stop_reason: "",
  };
}
