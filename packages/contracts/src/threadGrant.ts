import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const BOT_WILDCARD_GRANT = /^bot:[A-Za-z0-9_-]{1,64}:\*$/;
const THREAD_GRANT_MAX_LENGTH = 200;

/** True for `bot:<botId>:*`, the only wildcard a grant may carry. */
export const isBotWildcardThreadGrant = (grant: string): boolean => BOT_WILDCARD_GRANT.test(grant);

/**
 * Limits a session to one thread: an exact thread id, or `bot:<botId>:*` for every thread of one
 * bot (its generations and side threads). A grant only narrows the session's scopes.
 */
export const AuthThreadGrant = Schema.String.check(
  Schema.makeFilter(
    (grant) =>
      isBotWildcardThreadGrant(grant) ||
      (grant.length > 0 &&
        grant.length <= THREAD_GRANT_MAX_LENGTH &&
        grant === grant.trim() &&
        !grant.includes("*")) ||
      new SchemaIssue.InvalidValue({ message: "Expected a thread id or bot:<botId>:*" }),
    { identifier: "AuthThreadGrant" },
  ),
).pipe(Schema.brand("AuthThreadGrant"));
export type AuthThreadGrant = typeof AuthThreadGrant.Type;
