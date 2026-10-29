import type { BotsHostStatus } from "@t3tools/contracts";

/** Settings → Bots → This host: what the bots host was started with. Stub: n4b implements it. */
export function HostStatusSection(_props: {
  readonly status: BotsHostStatus;
  readonly bots: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}) {
  return null;
}
