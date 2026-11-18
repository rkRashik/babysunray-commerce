import { maintenanceResponse } from "@/api/maintenance";
import { getDb } from "@/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A run starts no job after 45 s (src/modules/maintenance/jobs.ts); this is the host's limit for the whole function.
export const maxDuration = 60;

// POST /api/internal/maintenance (and GET when MAINTENANCE_ALLOW_GET=true): off (404) unless MAINTENANCE_SECRET is set; see src/api/maintenance.ts.
const handle = (request: Request) => maintenanceResponse(request, { db: getDb, env: process.env });
export { handle as POST, handle as GET, handle as PUT, handle as DELETE, handle as PATCH };
