import { getDb } from "@/db/client";
import { pgErrorCode } from "@/db/database";
import { getPrincipal } from "@/modules/auth/principal";
import { getAuth } from "@/modules/auth/server";
import { DomainError } from "@/modules/domain-error";
import { createExport, EXPORT_TOO_LARGE } from "@/modules/exports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /admin/exports/download: one export, streamed as an attachment (requirements D-1 to D-6). Browser
// transport: the session cookie only (an Authorization header is ignored). A POST from this site's own origin
// only, so another site cannot make the Owner's browser request (and audit) an export. Errors go back to the
// export page with a fixed error code, never the input.

const PRIVATE = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

const back = (code: string) => new Response(null, { status: 303, headers: { ...PRIVATE, location: `/admin/exports?error=${code}` } });

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

function stream(chunks: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        // The download is cut off (the browser shows it as failed); never a silently short file.
        console.error(JSON.stringify({ level: "error", event: "export_stream_failed", errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
        controller.error(new Error("Export failed."));
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (request.headers.get("origin") !== getAuth().options.baseURL) return new Response("Forbidden", { status: 403, headers: PRIVATE });
    const principal = await getPrincipal(getAuth(), getDb(), request.headers);
    if (!principal) return new Response(null, { status: 303, headers: { ...PRIVATE, location: "/admin/login" } });
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return back("invalid");
    }
    const file = await createExport(getDb(), principal, {
      dataset: field(form, "dataset") ?? "",
      format: field(form, "format") ?? "",
      filters: {
        from: field(form, "from"),
        to: field(form, "to"),
        source: field(form, "source"),
        orderStatus: field(form, "orderStatus"),
        fulfilmentStatus: field(form, "fulfilmentStatus"),
        paymentStatus: field(form, "paymentStatus"),
      },
    });
    return new Response(stream(file.chunks), {
      status: 200,
      headers: { ...PRIVATE, "content-type": file.contentType, "content-disposition": `attachment; filename="${file.filename}"` },
    });
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === "FORBIDDEN" || error.code === "UNAUTHENTICATED") return new Response("Forbidden", { status: 403, headers: PRIVATE });
      return back(error.message === EXPORT_TOO_LARGE ? "too_large" : "invalid");
    }
    console.error(JSON.stringify({ level: "error", event: "export_failed", errorName: error instanceof Error ? error.name : typeof error, sqlState: pgErrorCode(error) ?? null }));
    return back("failed");
  }
}
