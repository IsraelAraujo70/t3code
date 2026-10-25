import {
  isUpdateAvailable,
  type SelfUpdateSnapshot,
} from "@t3tools/client-runtime/app-self-update";
import type { GUEST_API_ROUTES, GuestAppUpdateInfo } from "@t3tools/contracts";

/** Copies of the contract's routes; `satisfies` fails the typecheck if they ever drift. */
export const APP_UPDATE_ROUTES = {
  info: "/guest/v1/app-update" satisfies (typeof GUEST_API_ROUTES)["appUpdate"],
  apk: "/guest/v1/app-update/apk" satisfies (typeof GUEST_API_ROUTES)["appUpdateApk"],
} as const;

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The server's answer, checked by hand: the app only imports types from the contracts. A build
 * missing a field the update relies on (commit, size, sha256) makes the whole answer invalid.
 */
export function parseAppUpdateInfo(value: unknown): GuestAppUpdateInfo {
  if (typeof value !== "object" || value === null || !("latest" in value)) {
    throw new Error("resposta inválida do servidor.");
  }
  const latest = value.latest;
  if (latest === null) return { latest: null };
  if (typeof latest !== "object") throw new Error("resposta inválida do servidor.");
  const field = (name: string): unknown => (name in latest ? Reflect.get(latest, name) : undefined);
  const commit = field("commit");
  const shortCommit = field("shortCommit");
  const commitDate = field("commitDate");
  const builtAt = field("builtAt");
  const size = field("size");
  const sha256 = field("sha256");
  if (
    typeof commit !== "string" ||
    !COMMIT.test(commit) ||
    typeof shortCommit !== "string" ||
    typeof commitDate !== "string" ||
    typeof builtAt !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof sha256 !== "string" ||
    !SHA256.test(sha256)
  ) {
    throw new Error("resposta inválida do servidor.");
  }
  return { latest: { commit, shortCommit, commitDate, builtAt, size, sha256 } };
}

export type NoticeContent =
  | { readonly kind: "hidden" }
  | { readonly kind: "busy"; readonly text: string }
  | {
      readonly kind: "offer";
      readonly title: string;
      readonly body: string;
      readonly action: string;
    };

/**
 * What the update notice says. Bia sees a plain offer, then what the app is doing; a failure only
 * shows after she tapped Atualizar (`tried`), so a background check that failed says nothing.
 */
export function noticeContent(snapshot: SelfUpdateSnapshot, tried: boolean): NoticeContent {
  const { phase } = snapshot;
  switch (phase.type) {
    case "downloading":
      return {
        kind: "busy",
        text:
          phase.fraction === null
            ? "Baixando a atualização…"
            : `Baixando a atualização… ${Math.round(phase.fraction * 100)}%`,
      };
    case "verifying":
      return { kind: "busy", text: "Conferindo a atualização…" };
    case "installing":
      return { kind: "busy", text: "Abrindo o instalador…" };
    case "idle":
    case "checking":
      break;
  }
  if (
    !isUpdateAvailable(snapshot.embedded, snapshot.latest) ||
    snapshot.dismissedCommit === snapshot.latest.commit
  ) {
    return { kind: "hidden" };
  }
  if (tried && snapshot.error !== null) {
    return {
      kind: "offer",
      title: "A atualização não deu certo",
      body: "Confira sua internet e tente de novo daqui a pouco.",
      action: "Tentar de novo",
    };
  }
  return {
    kind: "offer",
    title: "Atualização disponível",
    body: "Tem uma versão nova do app. Leva só um minutinho.",
    action: "Atualizar",
  };
}
