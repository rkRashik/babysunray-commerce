import { getDb } from "@/db/client";
import { pgErrorCode } from "@/db/database";
import { assertPermission, getPrincipal } from "@/modules/auth/principal";
import { getAuth } from "@/modules/auth/server";
import { validateId } from "@/modules/catalogue/rules";
import { DomainError } from "@/modules/domain-error";
import { imageProblemOf, MAX_UPLOAD_BYTES } from "@/modules/media/images";
import { uploadPhotoOnce } from "@/modules/media/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /office/products/{productId}/photos/upload: one photo (multipart form) for a draft product, optionally
// replacing one. Browser transport like the export download: the session cookie only, a POST from this site's
// own origin only (CSRF), and errors go back to the photos page as a fixed code, never the input or a file
// name. The body is limited while it is read, so an oversized upload never fills memory.

const PRIVATE = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
// The photo plus the form's text fields and multipart framing.
const MAX_BODY = MAX_UPLOAD_BYTES + 64 * 1024;

const see = (location: string) => new Response(null, { status: 303, headers: { ...PRIVATE, location } });

/** Reads at most `limit` bytes of the body; null if it is longer. */
async function readLimited(request: Request, limit: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

const ERRORS: Partial<Record<DomainError["code"], string>> = {
  VERSION_CONFLICT: "conflict",
  PRODUCT_NOT_EDITABLE: "archived",
  MEDIA_NOT_FOUND: "missing",
  MEDIA_STORAGE_UNAVAILABLE: "storage",
  IDEMPOTENCY_KEY_REUSED: "resubmitted",
};

export async function POST(request: Request, { params }: { params: Promise<{ productId: string }> }): Promise<Response> {
  let productId: string;
  try {
    productId = validateId((await params).productId, "productId");
  } catch {
    return new Response("Not found", { status: 404, headers: PRIVATE });
  }
  const back = (query: string) => see(`/office/products/${productId}/photos?${query}`);
  try {
    if (request.headers.get("origin") !== getAuth().options.baseURL) return new Response("Forbidden", { status: 403, headers: PRIVATE });
    const principal = await getPrincipal(getAuth(), getDb(), request.headers);
    if (!principal) return see("/office/login");
    assertPermission(principal, "catalog:write");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > MAX_BODY) return back("error=too_large");
    const body = await readLimited(request, MAX_BODY);
    if (!body) return back("error=too_large");
    let form: FormData;
    try {
      form = await new Request(request.url, { method: "POST", headers: { "content-type": request.headers.get("content-type") ?? "" }, body: new Uint8Array(body) }).formData();
    } catch {
      return back("error=invalid");
    }
    const file = form.get("image");
    if (!(file instanceof File) || file.size === 0) return back("error=empty");
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const replaceMediaId = text("replaceMediaId") || null;
    const version = /^[0-9]{1,10}$/.test(text("version")) ? Number(text("version")) : 0;
    await uploadPhotoOnce(getDb(), principal, text("idempotencyKey"), {
      productId,
      expectedVersion: version,
      bytes: Buffer.from(await file.arrayBuffer()),
      altEn: text("altEn") || null,
      altBn: text("altBn") || null,
      replaceMediaId,
    });
    return back(`done=${replaceMediaId ? "photo-replaced" : "photo-uploaded"}`);
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === "FORBIDDEN") return new Response("Forbidden", { status: 403, headers: PRIVATE });
      const problem = imageProblemOf(error);
      if (problem) return back(`error=${problem}`);
      const code = ERRORS[error.code];
      if (code) return back(`error=${code}`);
      if (error.code === "INVALID_INPUT") return back("error=invalid");
    }
    console.error(JSON.stringify({ level: "error", event: "photo_upload_failed", errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return back("error=failed");
  }
}
