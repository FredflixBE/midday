import { describe, expect, test } from "bun:test";
import { amountInUnit, hoursToUnit, rateInUnit, unitToHours } from "./unit";

const hours = { displayUnit: "hours", hoursPerDay: 8 } as const;
const days = { displayUnit: "days", hoursPerDay: 8 } as const;
const shortDays = { displayUnit: "days", hoursPerDay: 7.6 } as const;

describe("a quote in hours", () => {
  test("shows and stores hours as they are", () => {
    expect(hoursToUnit(7.5, hours)).toBe(7.5);
    expect(unitToHours(7.5, hours)).toBe(7.5);
    expect(amountInUnit({ amount: 8, max: 12 }, hours)).toEqual({
      amount: 8,
      max: 12,
    });
  });

  test("charges the hourly rate", () => {
    expect(rateInUnit(10_000, hours)).toBe(10_000);
  });
});

describe("a quote in days", () => {
  test("stores days typed as hours, at the quote's hours per day", () => {
    expect(unitToHours(2, days)).toBe(16);
    expect(unitToHours(0.5, days)).toBe(4);
    expect(unitToHours(1.5, shortDays)).toBe(11.4);
  });

  test("shows hours as days, to the hundredth", () => {
    expect(hoursToUnit(16, days)).toBe(2);
    expect(hoursToUnit(10, days)).toBe(1.25);
    expect(hoursToUnit(10, shortDays)).toBe(1.32);
  });

  test("stores hours to the hundredth, and shows back what was typed", () => {
    expect(unitToHours(1.33, shortDays)).toBe(10.11);
    for (const typed of [0.01, 0.25, 1.33, 2.07, 17.99, 250.5]) {
      expect(hoursToUnit(unitToHours(typed, shortDays), shortDays)).toBe(typed);
    }
  });

  test("converts a range and leaves a missing maximum missing", () => {
    expect(amountInUnit({ amount: 8, max: 12 }, days)).toEqual({
      amount: 1,
      max: 1.5,
    });
    expect(amountInUnit({ amount: 8, max: null }, days)).toEqual({
      amount: 1,
      max: null,
    });
  });

  test("charges a day rate of hours per day times the hourly rate", () => {
    expect(rateInUnit(10_000, days)).toBe(80_000);
    expect(rateInUnit(10_000, shortDays)).toBe(76_000);
    expect(rateInUnit(10_050, { displayUnit: "days", hoursPerDay: 7.5 })).toBe(
      75_375,
    );
  });
});
