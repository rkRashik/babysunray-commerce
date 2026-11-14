import "server-only";
import { getDb } from "@/db/client";
import { type Auth, createAuth } from "./auth";
import { readAuthSettings } from "./settings";

let auth: Auth | undefined;

/** The application's Better Auth instance, created on first use so a build needs no secrets. */
export function getAuth(): Auth {
  auth ??= createAuth(getDb(), readAuthSettings(process.env));
  return auth;
}
