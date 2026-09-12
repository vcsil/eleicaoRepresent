import { describe, expect, it } from "vitest";
import { draftToPayload, getPositionTotal, NULL_OPTION_KEY, type BallotDraft } from "@/lib/vote/draft";

describe("getPositionTotal", () => {
  it("sums quantities across candidates and Nulo for a position", () => {
    const draft: BallotDraft = {
      marketing: { candidateA: 2, candidateB: 1, [NULL_OPTION_KEY]: 0 },
    };
    expect(getPositionTotal(draft, "marketing")).toBe(3);
  });

  it("returns 0 for a position with no allocations yet", () => {
    expect(getPositionTotal({}, "presidente")).toBe(0);
  });

  it("counts votes concentrated entirely on one candidate", () => {
    const draft: BallotDraft = { eventos: { candidateA: 4 } };
    expect(getPositionTotal(draft, "eventos")).toBe(4);
  });

  it("counts votes cast entirely as Nulo", () => {
    const draft: BallotDraft = { eventos: { [NULL_OPTION_KEY]: 4 } };
    expect(getPositionTotal(draft, "eventos")).toBe(4);
  });
});

describe("draftToPayload", () => {
  it("converts a draft into the RPC payload shape, omitting zero-quantity entries", () => {
    const draft: BallotDraft = {
      presidente: { candidateA: 1 },
      marketing: { candidateA: 2, candidateB: 1, [NULL_OPTION_KEY]: 0 },
    };

    const payload = draftToPayload(draft);

    expect(payload.positions).toHaveLength(2);
    const marketing = payload.positions.find((p) => p.position_id === "marketing");
    expect(marketing?.allocations).toEqual([
      { candidate_id: "candidateA", is_null_vote: false, quantity: 2 },
      { candidate_id: "candidateB", is_null_vote: false, quantity: 1 },
    ]);
  });

  it("maps the Nulo key to is_null_vote=true with a null candidate_id", () => {
    const draft: BallotDraft = { tesouraria: { [NULL_OPTION_KEY]: 2 } };
    const payload = draftToPayload(draft);
    expect(payload.positions[0].allocations).toEqual([
      { candidate_id: null, is_null_vote: true, quantity: 2 },
    ]);
  });
});
