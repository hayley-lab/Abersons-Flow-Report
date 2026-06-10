import { SEASONS } from "../seasons";

// seasons.js is a pure, committed module — a safe target for the initial
// test bootstrap. These assertions check structural invariants that hold
// regardless of the current year, so they stay green over time.
describe("SEASONS", () => {
  it("is a non-empty array of { id, name } entries", () => {
    expect(Array.isArray(SEASONS)).toBe(true);
    expect(SEASONS.length).toBeGreaterThan(0);
    for (const season of SEASONS) {
      expect(typeof season.id).toBe("string");
      expect(season.id).not.toHaveLength(0);
      expect(typeof season.name).toBe("string");
      expect(season.name).not.toHaveLength(0);
    }
  });

  it("has unique season ids", () => {
    const ids = SEASONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers 2025 with spring and fall only (no pre-seasons)", () => {
    const ids = SEASONS.map((s) => s.id);
    expect(ids).toContain("fall25");
    expect(ids).toContain("spring25");
    expect(ids).not.toContain("prefall25");
    expect(ids).not.toContain("prespring25");
  });

  it("treats 2026 as a transition year with spring and fall only", () => {
    const ids = SEASONS.map((s) => s.id);
    expect(ids).toContain("fall26");
    expect(ids).toContain("spring26");
    expect(ids).not.toContain("prefall26");
    expect(ids).not.toContain("prespring26");
  });

  it("covers 2027 with main and pre-season entries", () => {
    const ids = SEASONS.map((s) => s.id);
    expect(ids).toContain("fall27");
    expect(ids).toContain("prefall27");
    expect(ids).toContain("spring27");
    expect(ids).toContain("prespring27");
  });
});
