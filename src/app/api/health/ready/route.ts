import { readyResponse } from "@/api/health";
import { getDb } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Readiness: valid configuration and an answering database; a status word only (src/api/health.ts).
const handle = (request: Request) => readyResponse(request, { db: getDb, env: process.env });
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
