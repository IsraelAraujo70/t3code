/** A step's runtime requests: what they ask Israel, and his answer in the form the orchestrator takes. Pure. */
import * as Result from "effect/Result";

import type { ProviderApprovalDecision } from "@t3tools/contracts";

/** The turn item that carries a request's questions or approval details (the fields read here). */
export type RequestItem =
  | {
      readonly type: "user_input_request";
      readonly questions: ReadonlyArray<{
        readonly id: string;
        readonly header: string;
        readonly question: string;
        readonly options: ReadonlyArray<{ readonly label: string }>;
      }>;
    }
  | {
      readonly type: "approval_request";
      readonly requestKind: string;
      readonly prompt?: string | undefined;
      readonly reason?: string | undefined;
    };

export interface RequestResponse {
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: { readonly [questionId: string]: string };
}

/** The text of Israel's gate: each question with its options, or what the approval is for. */
export const requestText = (kind: string, item: RequestItem | undefined): string => {
  if (item?.type === "user_input_request") {
    return item.questions
      .map((q) => {
        const options = q.options.map((o) => o.label).join(", ");
        return `${q.header}: ${q.question}${options === "" ? "" : ` (options: ${options})`}`;
      })
      .join("\n");
  }
  if (item?.type === "approval_request") {
    const details = [item.prompt, item.reason].filter((text) => text !== undefined && text !== "");
    return [`The step's agent asks to approve a ${item.requestKind} request.`, ...details].join(
      "\n",
    );
  }
  return `The step's agent is waiting on a request (${kind}).`;
};

/**
 * Israel's answer for the orchestrator: a user-input request takes the text for each question; an
 * approval takes `accept`, and only from Israel. Feedback is only valid with a decline, so the text never rides an accept.
 */
export const requestResponse = (
  item: RequestItem | undefined,
  answer: "decline" | { readonly text: string },
  /** Who decided (`user`, `expiry`, `bot:<id>`): a bot never accepts an approval. */
  by?: string,
): Result.Result<RequestResponse, string> => {
  if (answer === "decline") return Result.succeed({ decision: "decline" });
  if (item?.type === "approval_request" && by?.startsWith("bot:"))
    return Result.succeed({ decision: "decline" });
  if (item?.type === "user_input_request") {
    return Result.succeed({
      answers: Object.fromEntries(item.questions.map((q) => [q.id, answer.text])),
    });
  }
  if (item?.type === "approval_request") return Result.succeed({ decision: "accept" });
  return Result.fail("The request's question was not found in the step thread.");
};
