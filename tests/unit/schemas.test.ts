import { describe, expect, it } from "vitest";
import {
  ballotSubmitSchema,
  voterValidationSchema,
  adminLoginSchema,
  candidateUpsertSchema,
} from "@/lib/validation/schemas";

const uuid1 = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";

describe("ballotSubmitSchema", () => {
  it("accepts a well-formed payload with a candidate and a Nulo allocation", () => {
    const result = ballotSubmitSchema.safeParse({
      positions: [
        {
          position_id: uuid1,
          allocations: [
            { candidate_id: uuid2, is_null_vote: false, quantity: 2 },
            { candidate_id: null, is_null_vote: true, quantity: 1 },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a decimal quantity", () => {
    const result = ballotSubmitSchema.safeParse({
      positions: [
        { position_id: uuid1, allocations: [{ candidate_id: uuid2, is_null_vote: false, quantity: 1.5 }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative quantity", () => {
    const result = ballotSubmitSchema.safeParse({
      positions: [
        { position_id: uuid1, allocations: [{ candidate_id: uuid2, is_null_vote: false, quantity: -1 }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unexpected extra field (payload adulterado)", () => {
    const result = ballotSubmitSchema.safeParse({
      positions: [
        {
          position_id: uuid1,
          allocations: [{ candidate_id: uuid2, is_null_vote: false, quantity: 1, totalVotes: 3 }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid position_id", () => {
    const result = ballotSubmitSchema.safeParse({
      positions: [{ position_id: "not-a-uuid", allocations: [{ candidate_id: uuid2, is_null_vote: false, quantity: 1 }] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("voterValidationSchema", () => {
  it("rejects an empty registration number", () => {
    expect(voterValidationSchema.safeParse({ registration_number: "", full_name: "João" }).success).toBe(
      false,
    );
  });

  it("accepts trimmed valid input", () => {
    expect(
      voterValidationSchema.safeParse({ registration_number: "2023001", full_name: "João da Silva" })
        .success,
    ).toBe(true);
  });
});

describe("adminLoginSchema", () => {
  it("rejects an empty password", () => {
    expect(adminLoginSchema.safeParse({ password: "" }).success).toBe(false);
  });
});

describe("candidateUpsertSchema", () => {
  it("rejects zero positions", () => {
    const result = candidateUpsertSchema.safeParse({
      full_name: "Maria",
      active: true,
      display_order: 0,
      position_ids: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than two positions", () => {
    const result = candidateUpsertSchema.safeParse({
      full_name: "Maria",
      active: true,
      display_order: 0,
      position_ids: [uuid1, uuid2, uuid1],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-YouTube video URL", () => {
    const result = candidateUpsertSchema.safeParse({
      full_name: "Maria",
      active: true,
      display_order: 0,
      position_ids: [uuid1],
      video_url: "https://vimeo.com/123",
    });
    expect(result.success).toBe(false);
  });

  // O identificador passou a exigir os 11 caracteres que o YouTube usa; a
  // fixture antiga ("abc123") era um valor inventado de 6.
  const VIDEO_ID = "ABCDEFGHIJK";

  function comVideo(video_url: string) {
    return candidateUpsertSchema.safeParse({
      full_name: "Maria",
      active: true,
      display_order: 0,
      position_ids: [uuid1],
      video_url,
    });
  }

  it("accepts a valid youtu.be URL", () => {
    expect(comVideo(`https://youtu.be/${VIDEO_ID}`).success).toBe(true);
  });

  it("aceita um link de YouTube Shorts", () => {
    expect(comVideo(`https://www.youtube.com/shorts/${VIDEO_ID}`).success).toBe(true);
  });

  it("aceita watch com parâmetros extras e o domínio móvel", () => {
    expect(comVideo(`https://www.youtube.com/watch?v=${VIDEO_ID}&si=abc`).success).toBe(true);
    expect(comVideo(`https://m.youtube.com/watch?v=${VIDEO_ID}`).success).toBe(true);
  });

  it("rejeita link do YouTube sem vídeo", () => {
    // Antes bastava começar com youtube.com: passava aqui e sumia no player.
    expect(comVideo("https://www.youtube.com/").success).toBe(false);
    expect(comVideo("https://www.youtube.com/@umcanal").success).toBe(false);
  });

  it("rejeita domínio que apenas imita o YouTube", () => {
    expect(comVideo(`https://youtube.com.exemplo-malicioso.com/watch?v=${VIDEO_ID}`).success).toBe(
      false,
    );
  });

  it("a mensagem de erro diz o que é aceito", () => {
    const resultado = comVideo("https://vimeo.com/123");
    expect(resultado.success).toBe(false);
    if (!resultado.success) {
      expect(resultado.error.issues[0].message).toMatch(/YouTube Shorts/);
    }
  });
});
