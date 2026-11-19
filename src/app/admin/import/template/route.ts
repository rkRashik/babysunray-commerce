import { getDb } from "@/db/client";
import { assertPermission, getPrincipal } from "@/modules/auth/principal";
import { getAuth } from "@/modules/auth/server";
import { csvTemplate, xlsxTemplate } from "@/modules/catalogue/import-template";
import { PRIVATE_HEADERS } from "../../_lib/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /admin/import/template?format=csv|xlsx: the blank catalogue import template (column names only).
export async function GET(request: Request): Promise<Response> {
  const principal = await getPrincipal(getAuth(), getDb(), request.headers);
  if (!principal) return new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, location: "/admin/login" } });
  try {
    assertPermission(principal, "catalog:write");
  } catch {
    return new Response("Forbidden", { status: 403, headers: PRIVATE_HEADERS });
  }
  const xlsx = new URL(request.url).searchParams.get("format") === "xlsx";
  const body = xlsx ? await xlsxTemplate() : csvTemplate();
  return new Response(new Uint8Array(body), {
    headers: {
      ...PRIVATE_HEADERS,
      "content-type": xlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="catalogue-import-template.${xlsx ? "xlsx" : "csv"}"`,
    },
  });
}
