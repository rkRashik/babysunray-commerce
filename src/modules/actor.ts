import { isIssuedUserActor } from "./auth/principal";
import { invalidInput } from "./domain-error";

/**
 * Who performed an audited action (requirement OF-9). A system actor is a named machine source. A user
 * actor carries the immutable id of an authenticated user. The only way to obtain one is
 * `actorFor(principal)` in src/modules/auth/principal.ts, for a principal whose session was verified in
 * this process; no exported function turns a user id or request field into a user actor.
 *
 * This is a code-structure guarantee inside one Node.js process, not a sandbox: code that can reach the
 * database directly can still write ledger rows. The database then still requires the user to exist.
 */
export type SystemActor = { type: "system"; ref: string };
export type UserActor = Readonly<{ type: "user"; ref: string }>;
export type Actor = SystemActor | UserActor;

// A machine label such as "integration-test" or "seed:dev", never a person's name or contact detail.
const ACTOR_REF = /^[a-z0-9][a-z0-9._:-]{0,99}$/;

export function validateActor(actor: Actor): Actor {
  if (actor?.type === "user") {
    if (!isIssuedUserActor(actor)) throw invalidInput("actor", "must come from a verified session");
    return actor;
  }
  if (actor?.type !== "system") throw invalidInput("actor.type", "must be system or user");
  if (typeof actor.ref !== "string" || !ACTOR_REF.test(actor.ref)) {
    throw invalidInput("actor.ref", "must be a lowercase machine label");
  }
  return { type: actor.type, ref: actor.ref };
}
