import { liveResponse } from "@/api/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness: the process answers. No database, no secrets (src/api/health.ts).
const handle = (request: Request) => liveResponse(request);
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
