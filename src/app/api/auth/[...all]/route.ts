import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/modules/auth/server";
import { authEndpointWork } from "@/modules/rate-limit/bulkhead";

// Better Auth's own endpoints (sign-in, sign-out, sessions) under /api/auth. Not a business API: the
// enabled and disabled paths are listed in src/modules/auth/auth.ts. Every request, even one Better Auth's rate
// limiter refuses, costs database work, so the handler runs in its own bulkhead (src/modules/rate-limit/bulkhead.ts):
// a flood of anonymous sign-in requests can slow sign-in but never take the connections the rest of Admin needs.
export const { GET, POST } = toNextJsHandler(async (request: Request) => {
  const done = await authEndpointWork(() => getAuth().handler(request));
  if (done.ok) return done.value;
  return new Response(JSON.stringify({ code: "BUSY", message: "Sign-in is busy right now. Try again in a moment." }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": "1" },
  });
});
