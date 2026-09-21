import { describe, expect, test } from "bun:test";
import {
  createCompactTickFormatter,
  getZeroInclusiveAxis,
  hasCompleteSeries,
} from "./chart-utils";

const format = createCompactTickFormatter();

describe("getZeroInclusiveAxis", () => {
  test("puts a tick on zero when the data straddles it", () => {
    const { domain, ticks } = getZeroInclusiveAxis([-12760, 12826, 32.89]);
    expect(ticks).toContain(0);
    expect(domain[0]).toBeLessThanOrEqual(-12760);
    expect(domain[1]).toBeGreaterThanOrEqual(12826);
  });

  test("never produces a label with a decimal point — the reported bug", () => {
    // The range from the screenshot on FF-1657, whose midpoint was 32.89.
    const { ticks } = getZeroInclusiveAxis([-12760, 12826, 32.89]);
    for (const tick of ticks) expect(format(tick)).not.toContain(".");
  });

  test("keeps every tick a whole multiple of the step", () => {
    for (const values of [
      [-12760, 12826],
      [0, 37],
      [-4, 9],
      [-950, 980],
      [-1_250_000, 3_400_000],
      [-17, 0],
    ]) {
      const { ticks } = getZeroInclusiveAxis(values);
      const step = ticks[1]! - ticks[0]!;
      for (const tick of ticks) {
        expect(Math.abs(tick % step)).toBeLessThan(1e-6);
      }
      expect(ticks).toContain(0);
    }
  });

  test("does not waste more than one step of headroom", () => {
    for (const values of [
      [-12760, 12826],
      [-3333, 11],
      [0, 950],
      [-40000, 5000],
    ]) {
      const { domain, ticks } = getZeroInclusiveAxis(values);
      const step = ticks[1]! - ticks[0]!;
      expect(domain[1] - Math.max(0, ...values)).toBeLessThan(step);
      expect(Math.min(0, ...values) - domain[0]).toBeLessThan(step);
    }
  });

  test("stays within the tick budget however awkward the range", () => {
    for (const values of [
      [-12760, 12826],
      [-1, 999],
      [-3333, 11],
      [0, 1_000_000],
      [-7, 7],
    ]) {
      expect(getZeroInclusiveAxis(values).ticks.length).toBeLessThanOrEqual(7);
    }
  });

  test("covers the data it is given", () => {
    for (const values of [
      [-12760, 12826],
      [-3333, 11],
      [2, 9],
      [-99, -1],
    ]) {
      const { domain } = getZeroInclusiveAxis(values);
      expect(domain[0]).toBeLessThanOrEqual(Math.min(0, ...values));
      expect(domain[1]).toBeGreaterThanOrEqual(Math.max(0, ...values));
    }
  });

  test("survives an all-zero range and ignores non-finite values", () => {
    expect(getZeroInclusiveAxis([0, 0]).ticks).toEqual([0, 1]);
    expect(getZeroInclusiveAxis([]).ticks).toEqual([0, 1]);
    expect(getZeroInclusiveAxis([Number.NaN, 10]).ticks).toContain(0);
  });
});

describe("createCompactTickFormatter", () => {
  test("rounds rather than printing raw decimals", () => {
    expect(format(32.89)).toBe("33");
    expect(format(0)).toBe("0");
    // Math.round gives -0 here; it must not reach the axis as "-0".
    expect(format(-0.4)).toBe("0");
  });

  test("still abbreviates the way it did", () => {
    expect(format(12000)).toBe("12k");
    expect(format(-7000)).toBe("-7k");
    expect(format(1_200_000)).toBe("1.2M");
  });
});

describe("hasCompleteSeries", () => {
  test("is false when the comparison is absent or all zero", () => {
    expect(
      hasCompleteSeries([{ previous: 0 }, { previous: 0 }], "previous"),
    ).toBe(false);
    expect(hasCompleteSeries([{ profit: 5 }], "previous")).toBe(false);
    expect(hasCompleteSeries([{ previous: null }], "previous")).toBe(false);
    expect(hasCompleteSeries([], "previous")).toBe(false);
  });

  test("is false for a partial previous period — the reported bug", () => {
    // Eight months with no history and one with a figure: the case that put
    // every bar half a slot right of its month.
    const months = Array.from({ length: 9 }, (_, index) => ({
      previous: index === 8 ? 8200 : 0,
    }));
    expect(hasCompleteSeries(months, "previous")).toBe(false);
  });

  test("is true once every month has a figure", () => {
    expect(
      hasCompleteSeries([{ previous: 12 }, { previous: -3 }], "previous"),
    ).toBe(true);
  });
});
