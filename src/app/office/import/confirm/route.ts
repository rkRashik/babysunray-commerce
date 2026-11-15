import { getDb } from "@/db/client";
import { pgErrorCode } from "@/db/database";
import { MAX_IMPORT_BYTES } from "@/modules/catalogue/import-file";
import { importCatalogueOnce } from "@/modules/catalogue/import-service";
import { DomainError } from "@/modules/domain-error";
import { checkUpload, formOf, PRIVATE_HEADERS, readLimited } from "../../_lib/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /office/import/confirm (multipart: file, fingerprint, idempotencyKey): imports a previewed file, all or
// nothing, once per key. If anything changed since the preview, nothing is created and the answer asks for a new
// preview. A retry with the same key returns the first result.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...PRIVATE_HEADERS, "content-type": "application/json; charset=utf-8" } });

export async function POST(request: Request): Promise<Response> {
  try {
    const check = await checkUpload(request, "catalog:write");
    if (!check.ok) return json(check.reason === "signed_out" ? 401 : 403, { error: check.reason });
    const body = await readLimited(request, MAX_IMPORT_BYTES + 64 * 1024);
    if (!body) return json(413, { error: "too_large", message: "The file is larger than 2 MB." });
    const form = await formOf(request, body);
    const file = form?.get("file");
    const text = (name: string) => {
      const value = form?.get(name);
      return typeof value === "string" ? value : "";
    };
    if (!(file instanceof File) || file.size === 0) return json(400, { error: "no_file", message: "Choose the file again and preview it." });
    const { value, replayed } = await importCatalogueOnce(getDb(), check.principal, text("idempotencyKey"), {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fingerprint: text("fingerprint"),
    });
    return json(200, { import: value, replayed });
  } catch (error) {
    if (error instanceof DomainError) {
      const status = error.code === "VERSION_CONFLICT" || error.code === "SLUG_TAKEN" || error.code === "SKU_TAKEN" ? 409 : error.code === "IDEMPOTENCY_KEY_REUSED" ? 422 : error.code === "FORBIDDEN" ? 403 : 400;
      const message =
        error.code === "SLUG_TAKEN" || error.code === "SKU_TAKEN"
          ? `${error.message} Another change took it after the preview. Nothing was imported. Preview the file again.`
          : error.code === "IDEMPOTENCY_KEY_REUSED"
            ? "This preview was already used for a different file. Preview the file again."
            : error.message;
      return json(status, { error: error.code, message });
    }
    console.error(JSON.stringify({ level: "error", event: "import_failed", errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return json(500, { error: "failed", message: "The import failed and nothing was created. Try again." });
  }
}
