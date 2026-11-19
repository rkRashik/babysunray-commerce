import "server-only";
import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "@/db/database";
import { customerAccounts, customerRateLimits, customerSessions, customerUsers, customerVerifications } from "@/db/schema";
import { type EmailSender, simpleMessage } from "../email/service";
import { MAX_PASSWORD_LENGTH } from "../auth/password-policy";
import { trustedClientHeaders } from "../rate-limit/client";

// Optional customer accounts (ADR-0011; ADR-0008 section 1): a SECOND Better Auth instance, separate from the Owner's
// (src/modules/auth/auth.ts) by construction:
// - its own tables (customer_*), cookie prefix ("bsr-customer") and base path (/api/customer-auth), and a secret derived
//   for it alone, so no customer cookie, session or row can be read by the Owner instance or the reverse;
// - Google and, when email is set up (ADR-0012), email and password with a verified address, password reset by email and
//   no account linking: an address registered one way cannot be taken over by signing in the other way, it is refused;
//   a Google account opens only with an address Google reports as verified; sign-up never reveals whether an address exists;
// - the minimum scopes (openid, email, profile) and no stored OAuth token: Google's tokens are dropped before every write
//   (the table's check refuses them too);
// - nothing here can grant an Admin permission: user_access references auth_users only, and getPrincipal and
//   getBearerPrincipal verify the Owner instance only.
// Only the endpoints in CUSTOMER_AUTH_ROUTES are reachable (enforced by the route); the rest answer 404 there.

export const CUSTOMER_BASE_PATH = "/api/customer-auth";
/** The redirect URI registered with Google for this installation (the OAuth client "BabySunRay Production"). */
export const GOOGLE_REDIRECT_PATH = "/api/auth/callback/google";
/** The only reachable customer-auth endpoints, as "METHOD path" under CUSTOMER_BASE_PATH. */
export const CUSTOMER_AUTH_ROUTES = [
  "POST /sign-in/social",
  "GET /callback/google",
  "POST /sign-out",
  "POST /sign-up/email",
  "POST /sign-in/email",
  "GET /verify-email",
  "POST /send-verification-email",
  "POST /request-password-reset",
  "GET /reset-password/:token",
  "POST /reset-password",
  "POST /change-password",
  "POST /update-user",
] as const;
/** The minimum customer password length (Better Auth's own minimum is 8; this matches common guidance). */
export const CUSTOMER_MIN_PASSWORD = 10;

/** Whether `METHOD /path` (below CUSTOMER_BASE_PATH) is an allowed endpoint; `:token` matches one URL-safe segment. */
export function customerRouteAllowed(route: string): boolean {
  return CUSTOMER_AUTH_ROUTES.some((allowed) => new RegExp(`^${allowed.replace(/:token$/, "[A-Za-z0-9_-]{8,256}")}$`).test(route));
}

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

const NO_TOKENS = { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null };

export type CustomerAuthSettings = {
  baseURL: string;
  secret: string;
  google: GoogleSettings | null;
  /** The transactional email sender; null when email is not set up (then no email and password accounts). */
  email: EmailSender | null;
  storeName?: string;
  env?: Record<string, string | undefined>;
};

export function createCustomerAuth(db: Db, settings: CustomerAuthSettings) {
  const send = settings.email;
  const store = settings.storeName ?? "Shop";
  return betterAuth({
    appName: "Shop",
    baseURL: settings.baseURL,
    basePath: CUSTOMER_BASE_PATH,
    secret: customerSecret(settings.secret),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: customerUsers, session: customerSessions, account: customerAccounts, verification: customerVerifications, rateLimit: customerRateLimits },
    }),
    emailAndPassword: send
      ? {
          enabled: true,
          requireEmailVerification: true,
          autoSignIn: false,
          minPasswordLength: CUSTOMER_MIN_PASSWORD,
          maxPasswordLength: MAX_PASSWORD_LENGTH,
          revokeSessionsOnPasswordReset: true,
          resetPasswordTokenExpiresIn: 60 * 60,
          sendResetPassword: async ({ user, url }) =>
            send(
              simpleMessage({
                to: user.email,
                subject: `${store}: reset your password`,
                lines: ["You asked to reset your password. The link works for one hour.", "পাসওয়ার্ড বদলাতে নিচের লিংকে যান। লিংকটি এক ঘণ্টা কাজ করবে।", "If you did not ask for it, ignore this email."],
                link: { url, label: "Set a new password · নতুন পাসওয়ার্ড" },
              }),
            ),
        }
      : { enabled: false },
    ...(send
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            expiresIn: 60 * 60 * 24,
            sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) =>
              send(
                simpleMessage({
                  to: user.email,
                  subject: `${store}: confirm your email`,
                  lines: ["Confirm your email address to finish creating your account.", "অ্যাকাউন্ট খোলা শেষ করতে আপনার ইমেইল নিশ্চিত করুন।"],
                  link: { url, label: "Confirm email · ইমেইল নিশ্চিত করুন" },
                }),
              ),
          },
        }
      : {}),
    socialProviders: settings.google
      ? {
          google: {
            clientId: settings.google.clientId,
            clientSecret: settings.google.clientSecret,
            // The URI registered with Google; its route hands the request to this instance's /callback/google.
            redirectURI: `${settings.baseURL}${GOOGLE_REDIRECT_PATH}`,
            prompt: "select_account",
            disableIdTokenSignIn: true,
          },
        }
      : {},
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
          // A Google account opens only with an address Google itself verified; an email sign-up starts unverified and
          // cannot sign in until the address is confirmed (requireEmailVerification).
          before: async (user, context) => (user.emailVerified === true || !context?.path?.startsWith("/callback") ? { data: user } : false),
        },
      },
      account: {
        create: {
          before: async (account) => {
            if (account.providerId === "google") return { data: { ...account, ...NO_TOKENS, password: null } };
            if (account.providerId === "credential" && send) return { data: { ...account, ...NO_TOKENS } };
            return false;
          },
        },
        update: { before: async (account) => ({ data: { ...account, ...NO_TOKENS } }) },
      },
    },
  });
}

export type CustomerAuth = ReturnType<typeof createCustomerAuth>;
