import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./formatTokens";

describe("formatTokenCount", () => {
  it("leaves small counts as plain integers", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("formats thousands with one decimal below 100k", () => {
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(12400)).toBe("12.4k");
    expect(formatTokenCount(99_949)).toBe("99.9k");
  });

  it("drops the decimal at or above 100 of a unit", () => {
    expect(formatTokenCount(142_000)).toBe("142k");
    expect(formatTokenCount(999_999)).toBe("1000k");
  });

  it("formats millions and billions", () => {
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
    expect(formatTokenCount(2_400_000)).toBe("2.4M");
    expect(formatTokenCount(1_100_000_000)).toBe("1.1B");
  });

  it("preserves sign for negative input", () => {
    expect(formatTokenCount(-12400)).toBe("-12.4k");
  });
});
