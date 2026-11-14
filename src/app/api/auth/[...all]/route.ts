import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/modules/auth/server";

// Better Auth's own endpoints (sign-in, sign-out, sessions) under /api/auth. Not a business API: the
// enabled and disabled paths are listed in src/modules/auth/auth.ts.
export const { GET, POST } = toNextJsHandler((request: Request) => getAuth().handler(request));
