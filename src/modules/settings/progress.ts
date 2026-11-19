import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/database";
import { assertPermission, type Principal } from "../auth/principal";
import { emailAvailable } from "../email/service";

// The store setup checklist (ADR-0012): what a new store has done, from its own data, in the order a new Owner works.
// Nothing here is stored: each step is done when the data says so, and stays editable in the normal Admin pages.

export type SetupStep = { id: string; title: string; titleBn: string; done: boolean; required: boolean; href: string; detail: string };

export async function storeSetupProgress(db: Db, principal: Principal, env: Record<string, string | undefined> = process.env): Promise<SetupStep[]> {
  assertPermission(principal, "settings:write");
  const ready = (await db.execute<{ ok: boolean }>(sql`select to_regclass('public.store_settings') is not null and to_regclass('public.policy_publications') is not null as ok`)).rows[0].ok;
  const { rows } = await db.execute<Record<string, number | boolean>>(sql`select
    ${ready ? sql`(select count(*) from store_settings where store_name is not null)::int` : sql`0`} as identity,
    ${ready ? sql`(select count(*) from store_settings where coalesce(contact_phone, contact_email, contact_whatsapp, contact_messenger) is not null)::int` : sql`0`} as contact,
    ${ready ? sql`(select count(*) from store_settings where logo_sha256 is not null)::int` : sql`0`} as logo,
    ${ready ? sql`(select count(*) from store_settings where rule_approved_at is not null)::int` : sql`0`} as rule,
    ${ready ? sql`(select count(distinct kind) from policy_publications p where p.event = 'published' and p.id = (select max(id) from policy_publications q where q.kind = p.kind))::int` : sql`0`} as policies,
    (select count(*) from delivery_zones where active)::int as zones,
    (select count(*) from product_categories)::int as categories,
    (select count(*) from products where status <> 'archived')::int as products,
    (select count(*) from inventory_balances where on_hand > 0)::int as stocked,
    (select count(*) from products where status = 'published')::int as published`);
  const r = rows[0] as Record<string, number>;
  const step = (id: string, title: string, titleBn: string, done: boolean, required: boolean, href: string, detail: string): SetupStep => ({ id, title, titleBn, done, required, href, detail });
  return [
    step("identity", "Store name and description", "দোকানের নাম ও পরিচিতি", r.identity > 0, true, "/admin/settings/store", "Shown in the shop, emails and Admin."),
    step("logo", "Logo", "লোগো", r.logo > 0, false, "/admin/settings/store", "Optional: without it the store name is shown as text."),
    step("contact", "Customer contact channels", "যোগাযোগের মাধ্যম", r.contact > 0, true, "/admin/settings/store", "Phone, email, WhatsApp or Messenger that customers may use."),
    step("zones", "Delivery areas and charges", "ডেলিভারি এলাকা ও চার্জ", r.zones >= 2, true, "/admin/settings/delivery", "Both areas need an active charge before orders can be taken."),
    step("categories", "Product categories", "পণ্যের ক্যাটাগরি", r.categories > 0, false, "/admin/categories", "Helps customers browse."),
    step("policies", "Delivery, return and privacy policies", "নীতিমালা", r.policies >= 3, true, "/admin/policies", "Your own wording, reviewed and published. Required before a public launch."),
    step("rule", "Publication requirements", "প্রকাশের শর্ত", r.rule > 0, true, "/admin/settings/publication", "Decide what every product needs before customers can see it."),
    step("product", "First product with photos, sizes and prices", "প্রথম পণ্য", r.products > 0, true, "/admin/products/new", "Create a product, add variants (size, colour, price) and photos."),
    step("stock", "Receive stock", "স্টক যোগ করুন", r.stocked > 0, true, "/admin", "Open a variant's SKU and receive the units you have."),
    step("publish", "Publish a product", "পণ্য প্রকাশ", r.published > 0, true, "/admin", "Review the product, then publish it from its page."),
    step("email", "Email for customer accounts", "ইমেইল সেটআপ", emailAvailable(env), false, "/admin/settings/store", "Set RESEND_API_KEY and EMAIL_FROM in the site's settings to offer customer sign-up and password reset."),
  ];
}
