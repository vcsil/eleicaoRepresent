import { describe, expect, it } from "vitest";
import { getPhaseBounds, getPhaseTimelineState, type ElectionPhase } from "@/lib/election/phases";

function makePhase(overrides: Partial<ElectionPhase>): ElectionPhase {
  return {
    id: "phase-1",
    election_id: "election-1",
    phase_key: "votacao",
    label: "Período de votação",
    starts_on: "2026-09-19",
    ends_on: "2026-09-23",
    start_time: "00:00:00",
    end_time: "23:59:59",
    time_configured: false,
    display_order: 6,
    ...overrides,
  };
}

describe("getPhaseBounds", () => {
  it("interprets dates/times in the fixed America/Sao_Paulo (UTC-03:00) offset", () => {
    const phase = makePhase({ starts_on: "2026-09-19", start_time: "08:00:00" });
    const { startsAt } = getPhaseBounds(phase);
    // 2026-09-19 08:00 -03:00 == 2026-09-19 11:00 UTC
    expect(startsAt.toISOString()).toBe("2026-09-19T11:00:00.000Z");
  });
});

describe("getPhaseTimelineState", () => {
  const phase = makePhase({ starts_on: "2026-09-19", ends_on: "2026-09-23" });

  it("is 'future' before the phase starts", () => {
    expect(getPhaseTimelineState(phase, new Date("2026-09-18T12:00:00Z"))).toBe("future");
  });

  it("is 'current' within the phase window", () => {
    expect(getPhaseTimelineState(phase, new Date("2026-09-20T12:00:00Z"))).toBe("current");
  });

  it("is 'past' after the phase ends", () => {
    expect(getPhaseTimelineState(phase, new Date("2026-09-25T12:00:00Z"))).toBe("past");
  });
});
