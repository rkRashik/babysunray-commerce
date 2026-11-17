import { apiPost, methodNotAllowed } from "@/api/v1/http";
import { statementCheckRequest } from "@/api/v1/order-schemas";
import { checkCourierStatementOnce } from "@/modules/orders/statements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/cod/statement-checks: a read-only comparison of a courier statement with the recorded COD money.
export const POST = apiPost<Record<string, never>, typeof statementCheckRequest>("payments:record", { body: statementCheckRequest, status: 201 }, async ({ body, idempotencyKey, db, principal }) =>
  checkCourierStatementOnce(db, principal, idempotencyKey, { csv: body.csv }),
);

export const { GET, PUT, PATCH, DELETE, OPTIONS } = methodNotAllowed("POST");
