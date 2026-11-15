import { getDb } from "@/db/client";
import { pgErrorCode } from "@/db/database";
import { validateId } from "@/modules/catalogue/rules";
import { DomainError } from "@/modules/domain-error";
import { imageProblemOf, MAX_UPLOAD_BYTES } from "@/modules/media/images";
import { uploadPhotoOnce } from "@/modules/media/operations";
import { checkUpload, formOf, PRIVATE_HEADERS, readLimited } from "../../../../_lib/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /office/products/{productId}/photos/upload: one photo (multipart form) for a draft product, optionally
// replacing one. Same-origin POST, session cookie, catalog:write and a byte-limited body (_lib/upload.ts); errors go
// back to the photos page as a fixed code, never the input or a file name.

// The photo plus the form's text fields and multipart framing.
const MAX_BODY = MAX_UPLOAD_BYTES + 64 * 1024;

const see = (location: string) => new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, location } });

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
    return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
  }
  const back = (query: string) => see(`/office/products/${productId}/photos?${query}`);
  try {
    const check = await checkUpload(request, "catalog:write");
    if (!check.ok) return check.reason === "signed_out" ? see("/office/login") : new Response("Forbidden", { status: 403, headers: PRIVATE_HEADERS });
    const body = await readLimited(request, MAX_BODY);
    if (!body) return back("error=too_large");
    const form = await formOf(request, body);
    if (!form) return back("error=invalid");
    const file = form.get("image");
    if (!(file instanceof File) || file.size === 0) return back("error=empty");
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const replaceMediaId = text("replaceMediaId") || null;
    const version = /^[0-9]{1,10}$/.test(text("version")) ? Number(text("version")) : 0;
    await uploadPhotoOnce(getDb(), check.principal, text("idempotencyKey"), {
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
      if (error.code === "FORBIDDEN") return new Response("Forbidden", { status: 403, headers: PRIVATE_HEADERS });
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
