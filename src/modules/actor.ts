import { invalidInput } from "./domain-error";

/**
 * Who performed an audited action. Until an authentication solution is approved there are no user
 * actors, only named system sources (requirement OF-9); the database rejects any other type.
 * A future authorisation boundary supplies a user actor; callers never construct one from input.
 */
export type Actor = { type: "system"; ref: string };

// A machine label such as "integration-test" or "seed:dev", never a person's name or contact detail.
const ACTOR_REF = /^[a-z0-9][a-z0-9._:-]{0,99}$/;

export function validateActor(actor: Actor): Actor {
  if (actor?.type !== "system") throw invalidInput("actor.type", "must be system");
  if (typeof actor.ref !== "string" || !ACTOR_REF.test(actor.ref)) {
    throw invalidInput("actor.ref", "must be a lowercase machine label");
  }
  return { type: actor.type, ref: actor.ref };
}
