import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/database";
import { userAccess } from "@/db/schema";
import type { Role } from "./permissions";

/** The user's current role, read from PostgreSQL on every call; null when the user has no active access. */
export async function findActiveRole(db: Db, userId: string): Promise<Role | null> {
  const [row] = await db
    .select({ role: userAccess.role })
    .from(userAccess)
    .where(and(eq(userAccess.userId, userId), isNull(userAccess.disabledAt)));
  return row?.role ?? null;
}
