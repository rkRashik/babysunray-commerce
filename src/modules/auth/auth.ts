import "server-only";
import { APIError, BASE_ERROR_CODES, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "@/db/database";
import { authAccounts, authRateLimits, authSessions, authUsers, authVerifications } from "@/db/schema";
import { findActiveRole } from "./access";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-policy";
import type { AuthSettings } from "./settings";

// Better Auth endpoints that stay reachable over HTTP. Everything else Better Auth registers is listed in
// DISABLED_PATHS (404). tests/db/auth-http.integration.test.ts fails if an endpoint is in neither list, so
// a library upgrade cannot silently expose a new one.
export const ENABLED_PATHS = [
  "/sign-in/email",
  "/sign-out",
  "/get-session",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/change-password",
  "/ok",
  "/error",
];

// Public sign-up (also refused by disableSignUp), and features that need an approval or a service this
// project does not have yet: email delivery, social sign-in, account deletion, profile and email changes.
// Better Auth matches these literally, so the two paths with parameters are not blocked by this list; they
// are inert because no social provider is configured and no reset token can be issued (tested).
export const DISABLED_PATHS = [
  "/sign-up/email",
  "/sign-in/social",
  "/callback/:id",
  "/update-session",
  "/update-user",
  "/delete-user",
  "/delete-user/callback",
  "/change-email",
  "/send-verification-email",
  "/verify-email",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/verify-password",
  "/link-social",
  "/list-accounts",
  "/unlink-account",
  "/refresh-token",
  "/get-access-token",
  "/account-info",
];

/**
 * The Better Auth instance for one installation: email and password only, public sign-up refused,
 * sessions in PostgreSQL with no cookie cache, PostgreSQL-backed rate limiting, CSRF and origin checks on
 * (also under NODE_ENV=test, where Better Auth would otherwise turn them off). ADR-0003 explains each choice.
 */
export function createAuth(db: Db, settings: AuthSettings) {
  return betterAuth({
    baseURL: settings.baseURL,
    secret: settings.secret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        rateLimit: authRateLimits,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    session: {
      // Every request reads the session row, so sign-out and revocation take effect at once.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
    },
    disabledPaths: DISABLED_PATHS,
    advanced: {
      database: { generateId: "uuid" },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      // No client-supplied header is trusted for the client IP: there is no known proxy until hosting is
      // decided. Locally every request counts as 127.0.0.1; in production all clients share one bucket per
      // path (fails closed against header spoofing, at the cost of a shared limit). Revisit with hosting.
      ipAddress: { ipAddressHeaders: [] },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          // A user without active access (no role, or disabled) cannot start a session. Same response as a
          // wrong password, so the endpoint does not reveal which accounts exist or are disabled.
          before: async (session) => {
            if ((await findActiveRole(db, session.userId)) === null) {
              throw APIError.from("UNAUTHORIZED", BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
