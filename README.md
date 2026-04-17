# em -- AI Coding Agent DevTools CLI

`em` is a command-line tool that provides observability and evaluation capabilities for Claude Code and Coco sessions. It extracts structured metrics from raw session logs, detects behavioral patterns, and runs reproducible eval suites with CI integration.

**Version:** 0.1.0

## Installation

```bash
npm install -g em-metrics
```

### From Source

```bash
git clone <repo>
cd eval-metrics
npm install
npm run build && npm link
```

## Quick Start

```bash
# Watch a live Claude Code session
em watch

# Review the last completed session
em show --last

# Aggregate metrics from the past week
em analyze --since 2026-04-04

# Run an eval task
em eval run --task tasks/fix-bug.yaml
```

## Commands

### Observability

| Command | Description |
|---------|-------------|
| `watch` | Real-time monitor of an active Claude Code session |
| `show` | Show metrics for a completed session |
| `analyze` | Aggregate metrics across multiple sessions (supports `--json`, `--csv`, `--output`) |
| `trace` | Behavioral trace: tool call sequence and signals |
| `profile` | Agent capability profile by codebase module |
| `patterns` | Detect behavioral patterns across sessions |

### Evaluation

All eval commands live under the `em eval` subcommand group:

| Command | Description |
|---------|-------------|
| `eval run` | Run a single eval task from YAML |
| `eval batch` | Run a suite of eval tasks |
| `eval compare` | Compare two eval result files |
| `eval check` | CI regression check against a baseline |
| `eval trend` | Historical pass rate and cost trends |

## Command Examples

### show

```bash
em show --last                        # Last session, summary view
em show --session abc123 --detail     # Full detail for a specific session
em show --last --json --source coco   # JSON output from Coco session
```

### analyze

```bash
em analyze --since 2026-04-04               # Past 7 days
em analyze --since 2026-03-12 --until 2026-04-04  # Range
em analyze --since 2026-04-04 --json        # Machine-readable output
em analyze --source coco                    # Analyze Coco sessions only
em analyze --since 2026-04-04 --csv --output metrics.csv  # CSV export
em analyze --since 2026-04-04 --json --output data.json   # JSON export to file
```

### trace

```bash
em trace --last                       # Trace the last session
em trace --session abc123 --verbose   # Detailed trace with all signals
em trace --last --json --source coco
```

### profile

```bash
em profile --since 2026-03-28 --depth 2      # Module-level capability profile
em profile --since 2026-03-12 --json
```

### patterns

```bash
em patterns --since 2026-03-28 --min-occurrences 3
em patterns --since 2026-03-12 --json --source claude
```

### eval run / eval batch / eval compare / eval check / eval trend

```bash
# Run a single eval task with 5 trials
em eval run --task tasks/fix-bug.yaml --model claude-4-opus --trials 5

# Run a full eval suite
em eval batch --suite suites/core.yaml --model claude-4-opus --trials 3 --output results/

# Compare two result files
em eval compare results/v1.json results/v2.json --label-a baseline --label-b candidate

# CI regression check (exits 1 on regression)
em eval check --baseline results/v1.json --current results/v2.json --threshold 0.05

# View historical trends
em eval trend --history results/ --task fix-bug
```

## Key Metrics

**Token Efficiency** -- `tokens_per_loc`, `exploration_ratio`, `edit_precision`

**Interaction Quality** -- `user_followup_count`, `files_re_edited`, `abandonment`

**Cache Health** -- `overall_cache_hit_rate`, `cache_hit_rate_trend`, `compact_count`

**Cost** -- `cost_usd` (calculated per model pricing)

**Eval** -- `pass_rate`, `pass@k`, `flakiness`

### Health Ranges

| Metric | Healthy | Warning | Danger |
|--------|---------|---------|--------|
| cost_usd (single) | < $0.50 | $0.50 -- $2.00 | > $2.00 |
| tool_success_rate | > 95% | 90 -- 95% | < 90% |
| exploration_ratio | 30 -- 60% | 20 -- 30% or 60 -- 80% | < 20% or > 80% |
| edit_precision | > 70% | 50 -- 70% | < 50% |
| tokens_per_loc | < 50 | 50 -- 100 | > 100 |
| overall_cache_hit_rate | > 70% | 50 -- 70% | < 50% |

## Eval Framework

Define eval tasks in YAML:

```yaml
id: fix-null-check
name: Fix null pointer bug
prompt: "Fix the null pointer exception in src/parser.ts"
cwd: ./fixtures/null-check
setup: "git checkout buggy-branch"
teardown: "git checkout main"
graders:
  - type: code
    check: file_contains
    path: src/parser.ts
    pattern: "!= null"
  - type: llm
    prompt: "Does the fix handle all edge cases?"
```

**Grader types:**

- **code** -- `file_exists`, `file_contains`, `command` (exit code check)
- **llm** -- LLM-based scoring with a custom prompt

**Multi-trial metrics:** `pass@k` (any k of n pass), `pass^k` (all k pass), `flakiness` (variance across trials).

The `check` command integrates with CI pipelines. It compares current results against a baseline and exits with code 1 when regression exceeds the threshold.

## Data Sources

`em` reads session data from two sources, selected with `--source`:

| Source | Flag | Location |
|--------|------|----------|
| Claude Code | `--source claude` | `~/.claude/projects/<hash>/<id>.jsonl` |
| Coco | `--source coco` | `~/Library/Caches/coco/sessions/<id>/` (session.json + events.jsonl) |

When `--source` is omitted, Claude Code is used by default.

## Development

```bash
npm run dev       # Run CLI via tsx (no build step)
npm run build     # Compile TypeScript
npm test          # Run tests with vitest
```

**Runtime deps:** chalk, commander, js-yaml | **Dev deps:** vitest, tsx, typescript
