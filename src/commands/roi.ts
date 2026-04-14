/**
 * roi command — show subscription ROI vs API equivalent cost.
 */

import chalk from "chalk";
import type { EvalSessionMetrics } from "../types.js";
import { sum, avg } from "../stats.js";

const PLANS: Record<string, { label: string; short: string; monthly: number }> = {
  pro:   { label: "Claude Pro",      short: "Pro",    monthly: 20  },
  max5:  { label: "Claude Max (5×)", short: "Max 5×", monthly: 100 },
  max20: { label: "Claude Max (20×)",short: "Max 20×",monthly: 200 },
};

interface RoiOpts {
  plan?: string;
  since?: string;
  until?: string;
}

function bar(fraction: number, width = 18): string {
  const filled = Math.round(fraction * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function printRoi(allMetrics: EvalSessionMetrics[], opts: RoiOpts): void {
  const totalApiCost = sum(allMetrics.map((m) => m.cost_usd));
  const since = opts.since ?? "";
  const until = opts.until ?? new Date().toISOString().slice(0, 10);

  // Date range in days
  const sinceMs = since ? new Date(since).getTime() : 0;
  const untilMs = new Date(until).getTime();
  const days = since ? Math.max(1, Math.round((untilMs - sinceMs) / 86_400_000) + 1) : 30;

  const plan = opts.plan ? PLANS[opts.plan.toLowerCase()] : null;
  const subCost = plan ? plan.monthly : null;
  const saved = subCost !== null ? totalApiCost - subCost : null;
  const multiplier = subCost && subCost > 0 ? totalApiCost / subCost : null;

  const header = [
    chalk.bold(" Claude Code ROI"),
    since ? `${since} → ${until}` : until,
    `${allMetrics.length} session${allMetrics.length !== 1 ? "s" : ""}`,
  ].join(chalk.dim("  ·  "));
  console.log("\n" + header + "\n");

  // ── Core ROI box ──────────────────────────────────────────────
  // Columns: "  " + label(24) + "  " + sign(2) + amount(9) + suffix(9) = 48 inner
  const INNER = 48;
  const border = "─".repeat(INNER + 2);
  const fmtV = (n: number) => `$${n.toFixed(2).padStart(8)}`;
  // sign: "  " (positive/neutral) or "− " (deduction)
  const row = (label: string, sign: string, value: string, suffix = "") => {
    const content = `  ${label.padEnd(24)}  ${sign}${value}${suffix.padEnd(9)}`;
    return `  │${content.padEnd(INNER + 2)}│`;
  };

  console.log(`  ┌${border}┐`);
  console.log(row("API equivalent cost", "  ", fmtV(totalApiCost)));
  if (plan && subCost !== null) {
    console.log(row(`Subscription (${plan.short})`, "− ", fmtV(subCost), "  /mo"));
    // divider: aligns under the amount column (30 chars of indent, then dashes)
    const DASH_WIDTH = 10;
    const divContent = " ".repeat(30) + "─".repeat(DASH_WIDTH) + " ".repeat(INNER + 2 - 30 - DASH_WIDTH);
    console.log(`  │${divContent}│`);
    const savedAmt = saved !== null ? Math.abs(saved) : 0;
    const multStr  = multiplier !== null ? `  (${multiplier.toFixed(1)}×)` : "";
    const savedLabel = saved !== null && saved >= 0 ? "You saved" : "Extra cost";
    const savedLine  = saved !== null && saved >= 0
      ? chalk.green(row(savedLabel, "  ", fmtV(savedAmt), multStr))
      : chalk.red(row(savedLabel, "  ", fmtV(savedAmt), multStr));
    console.log(savedLine);
  }
  console.log(`  └${border}┘\n`);

  // ── Per-day / per-session ─────────────────────────────────────
  const perDay     = totalApiCost / days;
  const perSession = avg(allMetrics.map((m) => m.cost_usd));
  console.log(
    `  Per day ${chalk.cyan("$" + perDay.toFixed(2))}  ·  Per session ${chalk.cyan("$" + perSession.toFixed(2))}\n`
  );

  // ── Cost by model ─────────────────────────────────────────────
  const modelCosts: Record<string, number> = {};
  for (const m of allMetrics) {
    const key = m.model || "unknown";
    modelCosts[key] = (modelCosts[key] ?? 0) + m.cost_usd;
  }
  const sorted = Object.entries(modelCosts)
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    const maxCost = sorted[0][1];
    for (const [model, cost] of sorted) {
      const pct = totalApiCost > 0 ? (cost / totalApiCost) * 100 : 0;
      const b   = bar(maxCost > 0 ? cost / maxCost : 0);
      console.log(
        `  ${model.padEnd(22)}  $${cost.toFixed(2).padStart(7)}  ${chalk.dim(b)}  ${pct.toFixed(1).padStart(5)}%`
      );
    }
  }

  console.log("");
}
