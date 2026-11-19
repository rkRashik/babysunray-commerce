import { customerAuthResponse } from "@/app/_shop/customer-auth-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Customer sign-in (Google only; ADR-0011): POST sign-in/social and sign-out. Everything else under this path is 404.
// Separate from the Owner's /api/auth by tables, cookies and secret (src/modules/customers/auth.ts).
export { customerAuthResponse as GET, customerAuthResponse as POST };
