import { randomUUID } from "node:crypto";
import { problem } from "@/api/v1/http";

export const runtime = "nodejs";

// Any /api/v1 path without a route: a problem response instead of the HTML 404 page. Never reads a body.
const notFound = async () => problem("ROUTE_NOT_FOUND", randomUUID());
export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE, notFound as OPTIONS };
