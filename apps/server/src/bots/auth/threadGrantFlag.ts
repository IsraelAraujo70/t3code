import { AuthThreadGrant } from "@t3tools/contracts";
import { Flag } from "effect/cli";

/** `--thread <threadId|bot:<botId>:*>`: confine the issued credential to that thread. */
export const threadGrantFlag = Flag.String("thread").pipe(
  Flag.withSchema(AuthThreadGrant),
  Flag.withDescription(
    "Limit the credential to one thread id, or to every thread of a bot with bot:<botId>:*. It can then only send messages to, interrupt and read that thread.",
  ),
  Flag.optional,
);
