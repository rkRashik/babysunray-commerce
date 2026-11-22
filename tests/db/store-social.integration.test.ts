import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/database";
import type { Principal } from "../../src/modules/auth/principal";
import { storeIdentity, storeSettingsForAdmin, updateSocialLinks, updateSocialLinksOnce, updateStoreIdentity } from "../../src/modules/settings/store";
import { clearAuthState, createTestAuth, createVerifiedOwner } from "../support/auth";
import { errorCodeOf } from "../support/fixtures";
import { createTestDb } from "../support/test-database";

// The store's social profile links (migration 0023), against PostgreSQL: a database without the migration keeps working
// (identity and Admin read the other columns, the links wait), and with it the links are validated, saved with the
// version check and shown in the identity. Fictional values only.

let db: Db;
let pool: Pool;
let owner: Principal;
const ROLLBACK = new Error("rollback");

beforeAll(async () => {
  ({ db, pool } = await createTestDb(4));
  await clearAuthState(pool);
  ({ principal: owner } = await createVerifiedOwner(createTestAuth(db), db, pool, "social-owner@example.test"));
  await pool.query("insert into store_settings (id, store_name) values (1, 'Fictional Kids Social') on conflict (id) do update set store_name = excluded.store_name");
});

afterAll(async () => {
  await pool?.end();
});

describe("store social links", () => {
  // First, while this module has not yet seen the columns: a database without migration 0023 (simulated by dropping the
  // two columns inside a transaction that is rolled back).
  it("keeps the shop identity and the Admin settings working on a database without migration 0023", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`alter table store_settings drop constraint store_settings_social_valid, drop column social_facebook, drop column social_instagram`);
        const identity = await storeIdentity(tx, {});
        expect(identity.storeName).toBe("Fictional Kids Social");
        expect(identity.contact.facebook ?? null).toBeNull();
        const admin = await storeSettingsForAdmin(tx, owner);
        expect(admin.schemaReady).toBe(true);
        expect(admin.socialReady).toBe(false);
        expect(admin.settings?.storeName).toBe("Fictional Kids Social");
        // Saving links is refused with a clear message, before any statement could fail and abort the transaction.
        await expect(updateSocialLinks(tx, { facebook: "https://www.facebook.com/fictional", instagram: null, expectedVersion: admin.settings!.version }, owner.userId)).rejects.toThrow(/migration 0023/);
        expect((await storeIdentity(tx, {})).storeName).toBe("Fictional Kids Social");
        // The first save of all (no settings row yet) works too.
        await tx.execute(sql`delete from store_settings`);
        const first = await updateStoreIdentity(tx, { storeName: "Fictional First Save", lineEn: null, lineBn: null, contactPhone: null, contactEmail: null, contactWhatsapp: null, contactMessenger: null, expectedVersion: 0 }, owner.userId);
        expect(first.version).toBe(2);
        expect((await storeIdentity(tx, {})).storeName).toBe("Fictional First Save");
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  });

  it("validates, saves and clears the links with the version check, and the identity shows them", async () => {
    const version = async () => (await storeSettingsForAdmin(db, owner)).settings!.version;
    expect((await storeSettingsForAdmin(db, owner)).socialReady).toBe(true);

    for (const [facebook, instagram] of [
      ["http://www.facebook.com/fictional", null],
      ["https://www.facebook.com/", null],
      ["https://evil.example/facebook.com/x", null],
      [null, "https://twitter.com/fictional"],
      [null, "https://www.instagram.com/fictional profile/"],
    ]) {
      const expectedVersion = await version();
      expect(await errorCodeOf(updateSocialLinksOnce(db, owner, randomUUID(), { facebook, instagram, expectedVersion })), `${facebook} ${instagram}`).toBe("INVALID_INPUT");
    }

    const before = await version();
    await updateSocialLinksOnce(db, owner, randomUUID(), { facebook: "https://www.facebook.com/fictionalkids", instagram: " https://www.instagram.com/fictionalkids/ ", expectedVersion: before });
    expect(await version()).toBe(before + 1);
    const identity = await storeIdentity(db, {});
    expect(identity.contact.facebook).toBe("https://www.facebook.com/fictionalkids");
    expect(identity.contact.instagram).toBe("https://www.instagram.com/fictionalkids/");
    expect(identity.storeName).toBe("Fictional Kids Social");

    // A stale form is refused; an empty field removes the link.
    expect(await errorCodeOf(updateSocialLinksOnce(db, owner, randomUUID(), { facebook: "", instagram: "", expectedVersion: before }))).toBe("VERSION_CONFLICT");
    await updateSocialLinksOnce(db, owner, randomUUID(), { facebook: "", instagram: "", expectedVersion: before + 1 });
    expect((await storeIdentity(db, {})).contact.instagram).toBeNull();
  });
});
