import { describe, it, expect } from "vitest";
import { computeCostUsd, getModelPricing } from "../src/pricing.js";

describe("getModelPricing", () => {
  it("returns correct pricing for claude-sonnet-4-6", () => {
    const p = getModelPricing("claude-sonnet-4-6");
    expect(p).not.toBeNull();
    expect(p!.input).toBe(3);
    expect(p!.output).toBe(15);
    expect(p!.cache_read).toBe(0.3);
    expect(p!.cache_write).toBe(3.75);
  });

  it("resolves 'opus' alias to opus pricing", () => {
    const p = getModelPricing("opus");
    expect(p).not.toBeNull();
    expect(p!.input).toBe(5);
    expect(p!.output).toBe(25);
    expect(p!.cache_read).toBe(0.5);
    expect(p!.cache_write).toBe(6.25);
  });

  it("resolves 'codebase-internal' (Coco alias) to sonnet pricing", () => {
    const p = getModelPricing("codebase-internal");
    expect(p).not.toBeNull();
    expect(p!.input).toBe(3);
    expect(p!.output).toBe(15);
  });

  it("returns null for unknown model", () => {
    expect(getModelPricing("unknown-model")).toBeNull();
  });

  it("matches by prefix for dated model names", () => {
    const p = getModelPricing("claude-sonnet-4-6-20260101");
    expect(p).not.toBeNull();
    expect(p!.input).toBe(3);
    expect(p!.output).toBe(15);
  });
});

describe("computeCostUsd", () => {
  it("computes correct cost for known model", () => {
    // (1M/1M)*3 + (500K/1M)*15 + (200K/1M)*0.3 + (100K/1M)*3.75
    // = 3 + 7.5 + 0.06 + 0.375 = 10.935
    const cost = computeCostUsd(
      "claude-sonnet-4-6",
      1_000_000,
      500_000,
      200_000,
      100_000,
    );
    expect(cost).toBeCloseTo(10.935, 6);
  });

  it("returns 0 for unknown model", () => {
    const cost = computeCostUsd("unknown-model", 1000, 500, 200, 100);
    expect(cost).toBe(0);
  });
});
