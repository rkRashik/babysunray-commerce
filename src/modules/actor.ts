import { invalidInput } from "./domain-error";

/**
 * Who performed an audited action (requirement OF-9). A system actor is a named machine source. A user
 * actor carries the immutable id of an authenticated user and can only be obtained from the
 * authorisation boundary (`actorFor` in src/modules/auth/principal.ts), never built from input.
 */
export type SystemActor = { type: "system"; ref: string };
export type UserActor = Readonly<{ type: "user"; ref: string }>;
export type Actor = SystemActor | UserActor;

// A machine label such as "integration-test" or "seed:dev", never a person's name or contact detail.
const ACTOR_REF = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
// Better Auth ids in this project are PostgreSQL UUIDs, which PostgreSQL prints in lowercase.
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// User actors issued by the authorisation boundary. An object that looks like one but was not issued here
// (for example a request body) is rejected, so a caller cannot claim another user's identity.
const issuedUserActors = new WeakSet<object>();

/**
 * Issues a user actor for an id that the caller has just read from a verified session.
 * Only src/modules/auth/principal.ts calls this; nothing else may.
 */
export function issueUserActor(userId: string): UserActor {
  if (!USER_ID.test(userId)) throw new Error("A user actor needs a canonical user id.");
  const actor: UserActor = Object.freeze({ type: "user", ref: userId });
  issuedUserActors.add(actor);
  return actor;
}

export function validateActor(actor: Actor): Actor {
  if (actor?.type === "user") {
    if (!issuedUserActors.has(actor)) throw invalidInput("actor", "must come from a verified session");
    return actor;
  }
  if (actor?.type !== "system") throw invalidInput("actor.type", "must be system or user");
  if (typeof actor.ref !== "string" || !ACTOR_REF.test(actor.ref)) {
    throw invalidInput("actor.ref", "must be a lowercase machine label");
  }
  return { type: actor.type, ref: actor.ref };
}
