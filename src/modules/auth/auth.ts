import "server-only";
import { APIError, BASE_ERROR_CODES, type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import type { Db } from "@/db/database";
import { authAccounts, authRateLimits, authSessions, authUsers, authVerifications } from "@/db/schema";
import { findActiveRole } from "./access";
import { type AuthTransport, logAuditFailure, recordFailedSignIn, recordPasswordChanged, recordSessionEnded, recordSignIn, sessionEndReason, subjectDigest } from "./audit";
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

const SET_AUTH_TOKEN = "set-auth-token";

const transportOf = (headers: Headers | undefined): AuthTransport => (isBrowserRequest(headers) ? "browser" : "native");
const bodyField = (body: unknown, name: string): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined);

/**
 * A session that could not be audited must not stay usable: its cookie is dropped first (and with it the Bearer
 * token the plugin would derive), the session is deleted if the database allows, and the request is refused with a
 * fixed error. A failed delete is logged by name only (a database error message can contain the token); the session
 * then lives only until its expiry, with no client holding it.
 */
async function refuseUnauditedSession(
  ctx: { context: { responseHeaders?: Headers; internalAdapter: { deleteSession: (token: string) => Promise<unknown> } } },
  token: string,
): Promise<never> {
  ctx.context.responseHeaders?.delete("set-cookie");
  try {
    await ctx.context.internalAdapter.deleteSession(token);
  } catch (error) {
    logAuditFailure("session_refused", error);
  }
  throw APIError.from("INTERNAL_SERVER_ERROR", { code: "SIGN_IN_UNAVAILABLE", message: "Sign-in is not available right now. Try again later." });
}

// Browsers always send at least one of these (Sec-Fetch-* and Origin cannot be removed by page scripts).
// Native clients send none of them.
function isBrowserRequest(headers: Headers | undefined): boolean {
  if (!headers) return false;
  if (headers.has("cookie") || headers.has("origin")) return true;
  for (const name of headers.keys()) if (name.startsWith("sec-fetch-")) return true;
  return false;
}

/**
 * The Bearer plugin adds the signed session token as a readable `set-auth-token` response header to every
 * response that sets the session cookie, including a browser's sign-in and its daily session refresh.
 * That would hand page scripts the credential the HttpOnly cookie hides. This plugin runs after it and
 * removes the header from browser requests, so only native (non-browser) clients receive a token.
 */
const browserTokenGuard = {
  id: "browser-token-guard",
  hooks: {
    after: [
      {
        matcher: (ctx) => isBrowserRequest(ctx.request?.headers ?? ctx.headers),
        handler: createAuthMiddleware(async (ctx) => {
          const headers = ctx.context.responseHeaders;
          if (!headers?.has(SET_AUTH_TOKEN)) return;
          headers.delete(SET_AUTH_TOKEN);
          const exposed = (headers.get("access-control-expose-headers") ?? "")
            .split(",")
            .map((h) => h.trim())
            .filter((h) => h && h.toLowerCase() !== SET_AUTH_TOKEN);
          if (exposed.length) headers.set("access-control-expose-headers", exposed.join(", "));
          else headers.delete("access-control-expose-headers");
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

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
    // Security audit (migration 0017, audit.ts). Runs after the endpoint, also when it failed (the error is in
    // ctx.context.returned). Identities come only from Better Auth: the new session, or the request's session.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const transport = transportOf(ctx.request?.headers ?? ctx.headers);
        const returned = ctx.context.returned;
        if (ctx.path === "/sign-in/email") {
          const created = ctx.context.newSession;
          if (isAPIError(returned) || !created) {
            const status = isAPIError(returned) ? returned.statusCode : 0;
            const code = isAPIError(returned) ? bodyField(returned.body, "code") : undefined;
            await recordFailedSignIn(db, { digest: subjectDigest(settings.secret, bodyField(ctx.body, "email")), transport, status, code }).catch((error: unknown) =>
              logAuditFailure("sign_in_failed", error),
            );
            return;
          }
          try {
            await recordSignIn(db, { userId: created.user.id, sessionId: created.session.id, transport });
          } catch (error) {
            // No unaudited session stays usable: delete it, drop its cookie (and so the Bearer token the plugin
            // would derive from it) and refuse the sign-in.
            logAuditFailure("sign_in", error);
            await refuseUnauditedSession(ctx, created.session.token);
          }
          return;
        }
        if (ctx.path === "/change-password" && !isAPIError(returned) && ctx.context.session) {
          const userId = ctx.context.session.user.id;
          await recordPasswordChanged(db, { userId, transport, revokedOtherSessions: bodyField(ctx.body, "revokeOtherSessions") === true }).catch(
            (error: unknown) => logAuditFailure("password_changed", error),
          );
          // Revoking the other sessions gives this client a new one: recorded like a sign-in, and refused the same way.
          const renewed = ctx.context.newSession;
          if (renewed) {
            try {
              await recordSignIn(db, { userId, sessionId: renewed.session.id, transport, via: "password_change" });
            } catch (error) {
              logAuditFailure("sign_in", error);
              await refuseUnauditedSession(ctx, renewed.session.token);
            }
          }
        }
      }),
    },
    // Bearer transport for /api/v1 and future native clients (ADR-0004). requireSignature: only the signed
    // token is accepted; the raw token that get-session and list-sessions return in their JSON is not.
    // Order matters: the guard must run after the Bearer plugin's response hook.
    plugins: [bearer({ requireSignature: true }), browserTokenGuard],
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
        // Every session Better Auth deletes (sign-out, revocation, password change, expiry), once per session even
        // when concurrent requests end the same ones. The deletion itself never waits on or fails with the audit.
        delete: {
          after: async (session, context) => {
            // A session found expired while another endpoint read it is an expiry, not that endpoint's action.
            const expired = new Date(session.expiresAt).getTime() <= Date.now();
            const reason = expired ? "expired" : sessionEndReason(context?.path);
            const byUser = !["expired", "audit_unavailable", "other"].includes(reason);
            await recordSessionEnded(db, {
              sessionId: session.id,
              userId: session.userId,
              reason,
              // The holder of the session (who proved its token) or the authenticated user of the request.
              actorUserId: byUser ? (context?.context.session?.user.id ?? session.userId) : null,
              transport: context ? transportOf(context.request?.headers ?? context.headers) : null,
            }).catch((error: unknown) => logAuditFailure("session_ended", error));
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
