import { describe, expect, it } from "vite-plus/test";

import { botAvatarLook, EYES, HEADS, MOUTHS } from "./botAvatar.ts";

describe("botAvatarLook", () => {
  it("picks the same parts as friend's desktop for the same id", () => {
    // Expected indices come from friend's Rust `Look::of`.
    const cases = [
      { id: "b_34384f98370042acb9f749d8e840a95e", head: 3, eyes: 2, mouth: 0, blush: true },
      { id: "b_01", head: 2, eyes: 2, mouth: 1, blush: true },
      { id: "bot-7f3a", head: 0, eyes: 1, mouth: 1, blush: true },
    ];
    for (const { id, head, eyes, mouth, blush } of cases) {
      const look = botAvatarLook(id);
      expect(look.head).toBe(HEADS[head]);
      expect(look.eyes).toBe(EYES[eyes]);
      expect(look.mouth).toBe(MOUTHS[mouth]);
      expect(look.blush).toBe(blush);
    }
  });

  it("gives different bots different faces", () => {
    const looks = Array.from({ length: 7 }, (_, index) => botAvatarLook(`b_0${index + 1}`));
    expect(new Set(looks.map((look) => `${HEADS.indexOf(look.head)}:${look.body}`)).size).toBe(7);
  });
});
