import { getDb } from "@/db/client";
import { pgErrorCode } from "@/db/database";
import { DomainError } from "@/modules/domain-error";
import { removeStoreLogoOnce, uploadStoreLogoOnce } from "@/modules/settings/store";
import { checkUpload, formOf, PRIVATE_HEADERS, readLimited } from "../../../_lib/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /admin/settings/store/logo: upload (or, with remove=1, remove) the store logo. Same-origin POST, session cookie,
// settings:write and a byte-limited body (_lib/upload.ts), like the product photo upload.

const MAX_BODY = 5 * 1024 * 1024 + 64 * 1024;
const back = (query: string) => new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, location: `/admin/settings/store?${query}` } });

export async function POST(request: Request): Promise<Response> {
  try {
    const check = await checkUpload(request, "settings:write");
    if (!check.ok) return check.reason === "signed_out" ? new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, location: "/admin/login" } }) : new Response("Forbidden", { status: 403, headers: PRIVATE_HEADERS });
    const body = await readLimited(request, MAX_BODY);
    if (!body) return back("error=too_large");
    const form = await formOf(request, body);
    if (!form) return back("error=invalid");
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const expectedVersion = /^[0-9]{1,10}$/.test(text("version")) ? Number(text("version")) : 0;
    if (text("remove") === "1") {
      await removeStoreLogoOnce(getDb(), check.principal, text("idempotencyKey"), { expectedVersion });
      return back("done=logoRemoved");
    }
    const file = form.get("logo");
    if (!(file instanceof File) || file.size === 0) return back("error=empty");
    await uploadStoreLogoOnce(getDb(), check.principal, text("idempotencyKey"), { expectedVersion, bytes: Buffer.from(await file.arrayBuffer()) });
    return back("done=logoSaved");
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === "FORBIDDEN") return new Response("Forbidden", { status: 403, headers: PRIVATE_HEADERS });
      if (error.code === "VERSION_CONFLICT") return back("error=conflict");
      if (error.code === "INVALID_INPUT") return back("error=image");
    }
    console.error(JSON.stringify({ level: "error", event: "logo_upload_failed", errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return back("error=failed");
  }
}
