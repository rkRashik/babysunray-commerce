import { getDb } from "@/db/client";
import { storeLogo } from "@/modules/settings/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /brand/logo?v=<digest>: the logo the Owner uploaded in Admin settings (src/modules/settings/store.ts). A logo is public
// branding (the committed public/brand files are public too); it holds no personal data. The URL carries the logo's digest,
// so a new upload is a new URL and the old one can be cached.
export async function GET(): Promise<Response> {
  const logo = await storeLogo(getDb()).catch(() => null);
  if (!logo) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(new Uint8Array(logo.data), {
    headers: { "content-type": logo.contentType, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
  });
}
