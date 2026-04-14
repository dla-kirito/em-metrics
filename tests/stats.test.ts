import { describe, it, expect } from "vitest";
import { avg, med, p90, sum } from "../src/stats.js";

describe("avg", () => {
  it("returns 0 for empty array", () => {
    expect(avg([])).toBe(0);
  });

  it("returns the single element for length-1 array", () => {
    expect(avg([42])).toBe(42);
  });

  it("computes the arithmetic mean", () => {
    expect(avg([1, 2, 3, 4, 5])).toBe(3);
  });

  it("handles negative numbers", () => {
    expect(avg([-10, 10])).toBe(0);
  });
});

describe("med", () => {
  it("returns 0 for empty array", () => {
    expect(med([])).toBe(0);
  });

  it("returns the single element for length-1 array", () => {
    expect(med([7])).toBe(7);
  });

  it("returns middle value for odd-length array", () => {
    expect(med([3, 1, 2])).toBe(2);
  });

  it("returns average of two middle values for even-length array", () => {
    expect(med([1, 2, 3, 4])).toBe(2.5);
  });

  it("does not mutate the input array", () => {
    const arr = [3, 1, 2];
    med(arr);
    expect(arr).toEqual([3, 1, 2]);
  });
});

describe("p90", () => {
  it("returns 0 for empty array", () => {
    expect(p90([])).toBe(0);
  });

  it("returns the single element for length-1 array", () => {
    expect(p90([5])).toBe(5);
  });

  it("returns the 90th percentile value", () => {
    // sorted: [1,2,3,4,5,6,7,8,9,10], index = floor(10*0.9) = 9 → value 10
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
  });

  it("works with unsorted input", () => {
    // sorted: [10,20,30,40,50], index = floor(5*0.9) = 4 → value 50
    expect(p90([30, 10, 50, 20, 40])).toBe(50);
  });
});

describe("sum", () => {
  it("returns 0 for empty array", () => {
    expect(sum([])).toBe(0);
  });

  it("returns the single element for length-1 array", () => {
    expect(sum([99])).toBe(99);
  });

  it("sums all elements", () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
  });
});
