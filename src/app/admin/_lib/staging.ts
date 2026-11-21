import "server-only";
import { getDb } from "@/db/client";
import type { Db } from "@/db/database";
import { isStagingDatabase } from "@/modules/launch/acceptance";

/**
 * Whether Admin shows the "Test database (staging)" notice: only when the connected database itself carries the
 * founder's staging marker (the exact schema comment that acceptance requires; a production database is marked
 * 'babysunray:production' instead). No environment variable, header or setting can turn it on. When the database cannot
 * be read, no notice: the page then fails on its own reads anyway.
 */
export async function stagingDatabase(db: () => Db = getDb): Promise<boolean> {
  try {
    return await isStagingDatabase(db());
  } catch {
    return false;
  }
}
