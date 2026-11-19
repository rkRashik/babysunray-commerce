import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { pgErrorCode } from "@/db/database";
import { MAX_IMPORT_BYTES } from "@/modules/catalogue/import-file";
import { previewImport } from "@/modules/catalogue/import-service";
import { csvCell } from "@/modules/exports/formats";
import { checkUpload, formOf, PRIVATE_HEADERS, readLimited } from "../../_lib/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /admin/import/preview (multipart: file): reads and checks a catalogue file and answers with what an import
// would create and every problem by row and column. It changes nothing in the database. The answer also carries a
// fresh idempotency key for the import, and a sanitised error report (row, column, problem; never cell values).

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...PRIVATE_HEADERS, "content-type": "application/json; charset=utf-8" } });
const TEXT = { key: "", type: "text" } as const;

export async function POST(request: Request): Promise<Response> {
  try {
    const check = await checkUpload(request, "catalog:write");
    if (!check.ok) return json(check.reason === "signed_out" ? 401 : 403, { error: check.reason });
    const body = await readLimited(request, MAX_IMPORT_BYTES + 64 * 1024);
    if (!body) return json(413, { error: "too_large", message: "The file is larger than 2 MB. Split it into smaller files." });
    const form = await formOf(request, body);
    const file = form?.get("file");
    if (!(file instanceof File) || file.size === 0) return json(400, { error: "no_file", message: "Choose a CSV or XLSX file." });
    const preview = await previewImport(getDb(), check.principal, new Uint8Array(await file.arrayBuffer()));
    const report = preview.issues.length
      ? `﻿row,column,problem,message\r\n${preview.issues.map((i) => [String(i.line ?? ""), i.column ?? "", i.code, i.message].map((v) => csvCell(TEXT, v)).join(",")).join("\r\n")}\r\n`
      : null;
    return json(200, { ...preview, idempotencyKey: randomUUID(), errorReport: report });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "import_preview_failed", errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return json(500, { error: "failed", message: "The file could not be checked. Nothing was changed. Try again." });
  }
}
