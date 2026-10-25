import type { SelfUpdateSnapshot } from "@t3tools/client-runtime/app-self-update";
import { describe, expect, it } from "vite-plus/test";

import { noticeContent, parseAppUpdateInfo } from "./appUpdate";

const build = {
  commit: "b".repeat(40),
  shortCommit: "bbbbbbbbb",
  commitDate: "2026-10-25T10:00:00-03:00",
  builtAt: "2026-10-25T13:10:00Z",
  size: 58_000_000,
  sha256: "c".repeat(64),
};

const snapshot = (patch: Partial<SelfUpdateSnapshot> = {}): SelfUpdateSnapshot => ({
  embedded: { commit: "a".repeat(40), commitDate: "2026-10-24T10:00:00-03:00" },
  latest: build,
  checkedAt: 1,
  phase: { type: "idle" },
  error: null,
  dismissedCommit: null,
  ...patch,
});

describe("parseAppUpdateInfo", () => {
  it("reads a published build and nothing published", () => {
    expect(parseAppUpdateInfo({ latest: build })).toEqual({ latest: build });
    expect(parseAppUpdateInfo({ latest: null })).toEqual({ latest: null });
  });

  it.each([
    ["no latest", {}],
    ["an error body", { error: "Acesso inválido." }],
    ["a short sha256", { latest: { ...build, sha256: "abc" } }],
    ["an uppercase commit", { latest: { ...build, commit: "B".repeat(40) } }],
    ["a size as text", { latest: { ...build, size: "58000000" } }],
    ["a missing date", { latest: { ...build, commitDate: undefined } }],
  ])("refuses %s", (_name, body) => {
    expect(() => parseAppUpdateInfo(body)).toThrow("resposta inválida do servidor.");
  });
});

describe("noticeContent", () => {
  it("offers another build in plain words", () => {
    expect(noticeContent(snapshot(), false)).toEqual({
      kind: "offer",
      title: "Atualização disponível",
      body: "Tem uma versão nova do app. Leva só um minutinho.",
      action: "Atualizar",
    });
  });

  it.each([
    ["the running build", snapshot({ latest: { ...build, commit: "a".repeat(40) } })],
    ["nothing published", snapshot({ latest: null })],
    ["a build without an embedded commit", snapshot({ embedded: null })],
    ["a dismissed build", snapshot({ dismissedCommit: build.commit })],
  ])("hides for %s", (_name, state) => {
    expect(noticeContent(state, false)).toEqual({ kind: "hidden" });
  });

  it("says what the app is doing while it updates", () => {
    const busy = (phase: SelfUpdateSnapshot["phase"]) => noticeContent(snapshot({ phase }), true);
    expect(busy({ type: "downloading", fraction: 0.416 })).toEqual({
      kind: "busy",
      text: "Baixando a atualização… 42%",
    });
    expect(busy({ type: "downloading", fraction: null })).toEqual({
      kind: "busy",
      text: "Baixando a atualização…",
    });
    expect(busy({ type: "verifying" })).toEqual({
      kind: "busy",
      text: "Conferindo a atualização…",
    });
    expect(busy({ type: "installing" })).toEqual({ kind: "busy", text: "Abrindo o instalador…" });
  });

  it("shows a failure only after Bia tapped Atualizar", () => {
    const failed = snapshot({ error: "Atualização falhou: o servidor respondeu 500." });
    expect(noticeContent(failed, false)).toMatchObject({ action: "Atualizar" });
    expect(noticeContent(failed, true)).toEqual({
      kind: "offer",
      title: "A atualização não deu certo",
      body: "Confira sua internet e tente de novo daqui a pouco.",
      action: "Tentar de novo",
    });
  });
});
