import "server-only";
import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "@/db/database";
import { customerAccounts, customerRateLimits, customerSessions, customerUsers, customerVerifications } from "@/db/schema";
import { trustedClientHeaders } from "../rate-limit/client";

// Optional customer accounts (ADR-0011; ADR-0008 section 1): a SECOND Better Auth instance, separate from the Owner's
// (src/modules/auth/auth.ts) by construction:
// - its own tables (customer_*), cookie prefix ("bsr-customer") and base path (/api/customer-auth), and a secret derived
//   for it alone, so no customer cookie, session or row can be read by the Owner instance or the reverse;
// - Google only: no email or password, no account linking (a second Google account with the same address is refused,
//   never merged), and only an address Google reports as verified can create an account;
// - the minimum scopes (openid, email, profile) and no stored OAuth token: Google's tokens are dropped before every write
//   (the table's check refuses them too);
// - nothing here can grant an Admin permission: user_access references auth_users only, and getPrincipal and
//   getBearerPrincipal verify the Owner instance only.
// Only three HTTP paths are reachable (CUSTOMER_AUTH_ROUTES, enforced by the route); the rest of Better Auth's endpoints
// answer 404 there.

export const CUSTOMER_BASE_PATH = "/api/customer-auth";
/** The redirect URI registered with Google for this installation (the OAuth client "BabySunRay Production"). */
export const GOOGLE_REDIRECT_PATH = "/api/auth/callback/google";
/** The only reachable customer-auth endpoints, as "METHOD path" under CUSTOMER_BASE_PATH. */
export const CUSTOMER_AUTH_ROUTES = ["POST /sign-in/social", "GET /callback/google", "POST /sign-out"] as const;

export type GoogleSettings = { clientId: string; clientSecret: string };
export class CustomerAuthConfigError extends Error {
  override name = "CustomerAuthConfigError";
}

/**
 * Google sign-in settings from the environment: both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither (then customer
 * sign-in is simply not offered). Messages name the variable, never a value.
 */
export function readGoogleSettings(env: Record<string, string | undefined>): GoogleSettings | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new CustomerAuthConfigError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.");
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new CustomerAuthConfigError("GOOGLE_CLIENT_ID is not a Google OAuth web client id.");
  if (clientSecret.length < 16 || /\s/.test(clientSecret)) throw new CustomerAuthConfigError("GOOGLE_CLIENT_SECRET is not valid.");
  return { clientId, clientSecret };
}

/** A key for the customer instance alone, derived from the installation secret (no new setting to manage). */
export const customerSecret = (installationSecret: string) => createHmac("sha256", installationSecret).update("babysunray:customer-auth:v1").digest("base64url");

const NO_TOKENS = { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, password: null };

export function createCustomerAuth(db: Db, settings: { baseURL: string; secret: string; google: GoogleSettings; env?: Record<string, string | undefined> }) {
  return betterAuth({
    appName: "Shop",
    baseURL: settings.baseURL,
    basePath: CUSTOMER_BASE_PATH,
    secret: customerSecret(settings.secret),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: customerUsers, session: customerSessions, account: customerAccounts, verification: customerVerifications, rateLimit: customerRateLimits },
    }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: settings.google.clientId,
        clientSecret: settings.google.clientSecret,
        // The URI registered with Google; its route hands the request to this instance's /callback/google.
        redirectURI: `${settings.baseURL}${GOOGLE_REDIRECT_PATH}`,
        prompt: "select_account",
        disableIdTokenSignIn: true,
      },
    },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      updateAccountOnSignIn: false,
      storeStateStrategy: "database",
    },
    session: {
      cookieCache: { enabled: false },
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: { enabled: true, storage: "database" },
    onAPIError: { errorURL: "/en/order?signin=failed" },
    advanced: {
      cookiePrefix: "bsr-customer",
      database: { generateId: "uuid" },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: trustedClientHeaders(settings.env ?? process.env) },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // Only an address Google itself verified opens an account.
          before: async (user) => (user.emailVerified === true ? { data: user } : false),
        },
      },
      account: {
        create: { before: async (account) => (account.providerId === "google" ? { data: { ...account, ...NO_TOKENS } } : false) },
        update: { before: async (account) => ({ data: { ...account, ...NO_TOKENS } }) },
      },
    },
  });
}

export type CustomerAuth = ReturnType<typeof createCustomerAuth>;
