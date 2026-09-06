import { describe, expect, it } from "vitest";
import { buildSnapshotContent, type SnapshotData } from "./snapshotCard";

function data(overrides: Partial<SnapshotData> = {}): SnapshotData {
  return {
    tokens: {
      todayOutput: 2_400_000,
      todayInput: 380_000,
      todayCacheRead: 1_100_000,
      totalOutput: 40_000_000,
      totalInput: 9_000_000,
      sessionCount: 128,
    },
    sessionsToday: 4,
    projects: 3,
    best: { score: 8420, level: 6 },
    version: "0.3.0",
    now: new Date("2026-09-06T12:00:00.000Z"),
    ...overrides,
  };
}

describe("buildSnapshotContent", () => {
  it("formats the headline as the flex number: today's output tokens", () => {
    const content = buildSnapshotContent(data());
    expect(content.headline).toBe("2.4M");
    expect(content.headlineLabel).toBe("TOKENS OUT TODAY");
  });

  it("includes input and cache-read as the supporting line", () => {
    const content = buildSnapshotContent(data());
    expect(content.supportingLine).toBe("380k in · 1.1M cache read");
  });

  it("sums input+output for the all-time line and pluralizes correctly", () => {
    const content = buildSnapshotContent(data());
    expect(content.allTimeLine).toBe("49M all-time · 4 sessions today · 3 projects");

    const singular = buildSnapshotContent(data({ sessionsToday: 1, projects: 1 }));
    expect(singular.allTimeLine).toContain("1 session today");
    expect(singular.allTimeLine).toContain("1 project");
  });

  it("omits the best line entirely when there is no real run", () => {
    const content = buildSnapshotContent(data({ best: { score: 0, level: 1 } }));
    expect(content.bestLine).toBeNull();

    const noneAtAll = buildSnapshotContent(data({ best: null }));
    expect(noneAtAll.bestLine).toBeNull();
  });

  it("shows the Tarmac Defense best line when a real run exists", () => {
    const content = buildSnapshotContent(data());
    expect(content.bestLine).toBe("Tarmac Defense best: 8420 pts · Level 6");
  });

  it("formats the flight date like a boarding pass", () => {
    const content = buildSnapshotContent(data());
    expect(content.flightDate).toMatch(/^[A-Z]{3} \d{2} [A-Z]{3} 2026$/);
  });

  it("derives the tail number from the session count", () => {
    expect(buildSnapshotContent(data({ tokens: { ...data().tokens, sessionCount: 7 } })).tailNumber).toBe("AT-007");
  });
});
