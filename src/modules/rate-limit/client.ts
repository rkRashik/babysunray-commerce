import "server-only";
import { createHmac } from "node:crypto";

// The client's address, only from a proxy the installation names as trusted (ADR-0011). Netlify's edge sets
// `x-nf-client-connection-ip` on every request it forwards and replaces any value a client sends, so behind Netlify that
// header is the connecting client. Nothing else is trusted: no generic forwarding header, no other proxy header, and without
// TRUSTED_PROXY=netlify no header at all (a client could then claim any address). The address is never stored or logged:
// limits key on an HMAC of it under the installation secret.

const HEADERS: Record<string, string> = { netlify: "x-nf-client-connection-ip" };
const ADDRESS = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F:]{2,39}(?:%[0-9A-Za-z]{1,16})?)$/;

/** The address headers to trust: Netlify's when TRUSTED_PROXY is "netlify", none when it is unset. */
export function trustedClientHeaders(env: Record<string, string | undefined>): string[] {
  const proxy = env.TRUSTED_PROXY?.trim() ?? "";
  if (proxy === "") return [];
  const header = HEADERS[proxy];
  if (!header) throw new Error("TRUSTED_PROXY must be netlify or empty.");
  return [header];
}

/** An opaque per-client key (64 hex), or null when no trusted proxy names the client. */
export function clientKey(headers: Headers, env: Record<string, string | undefined>, secret: string): string | null {
  const [header] = trustedClientHeaders(env);
  if (!header) return null;
  const address = headers.get(header)?.trim() ?? "";
  if (!ADDRESS.test(address)) return null;
  return createHmac("sha256", secret).update(`babysunray:client:${address.toLowerCase()}`).digest("hex");
}
