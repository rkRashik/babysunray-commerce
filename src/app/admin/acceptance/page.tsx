import { cookies } from "next/headers";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { readAuthSettings } from "@/modules/auth/settings";
import { customerSignInAvailable } from "@/modules/customers/server";
import {
  ACCEPTANCE_COOKIE,
  acceptanceFacts,
  PASS_HOURS,
  verifyPass,
} from "@/modules/launch/acceptance";
import { publicShopGate } from "@/modules/launch/gate";
import { cdnConfig } from "@/modules/media/cdn";
import { publishedPolicies } from "@/modules/policies/publication";
import { trustedClientHeaders } from "@/modules/rate-limit/client";
import { ActionForm } from "../_components/action-form";
import {
  formatTime,
  noticeFor,
  AdminShell,
  Section,
} from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { endAcceptanceAction, startAcceptanceAction } from "./actions";

export const metadata = { title: "Shop acceptance · Admin" };

// Founder acceptance (ADR-0011): the real shop, real orders and real stock, for the founder only and on the staging
// database only. This page says whether it can run here, starts or ends it in this browser, and links to the shop.

const ROW =
  "grid grid-cols-1 gap-x-6 gap-y-1 py-2 text-sm sm:grid-cols-[14rem_1fr]";

function settingState(read: () => unknown): "set" | "not set" | "invalid" {
  try {
    return read() ? "set" : "not set";
  } catch {
    return "invalid";
  }
}

export default async function AcceptancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await requireAdmin("acceptance:run");
  const { done } = await searchParams;
  const db = getDb();
  const facts = await acceptanceFacts(db);
  const policies = await publishedPolicies(db);
  const pass = verifyPass(
    readAuthSettings(process.env).secret,
    (await cookies()).get(ACCEPTANCE_COOKIE)?.value,
  );
  const mine = pass?.userId === principal.userId;
  const cdn = cdnConfig(process.env);
  return (
    <AdminShell
      title="Shop acceptance"
      current="acceptance"
      notice={noticeFor(done)}
    >
      <div
        role="note"
        className="rounded border border-gray-400 bg-white p-4 text-sm"
      >
        <p className="font-semibold">
          The real shop, for you only, on the staging database only.
        </p>
        <p className="mt-1">
          Products you publish, orders you place, stock holds, tracking links
          and cash records are real records in the staging database, made by the
          same services the public shop will use. Use fictional names and phone
          numbers. Nothing here is public: the public launch gate stays closed,
          and the shop answers only a browser that holds an acceptance pass
          started on this page.
        </p>
      </div>

      <Section title="Can acceptance run here?">
        <dl className="divide-y divide-gray-200">
          <div className={ROW}>
            <dt className="text-gray-600">Public launch gate</dt>
            <dd data-testid="gate-state">
              {publicShopGate().open
                ? "Open"
                : "Closed (opening it is a separate decision)"}
            </dd>
          </div>
          <div className={ROW}>
            <dt className="text-gray-600">Database</dt>
            <dd data-testid="database-state">
              {facts.staging
                ? "Marked as the staging database: acceptance can run."
                : "Not marked as the staging database: acceptance cannot run here (by design on development and production)."}
            </dd>
          </div>
          <div className={ROW}>
            <dt className="text-gray-600">This browser</dt>
            <dd data-testid="pass-state">
              {mine
                ? `Holds an acceptance pass (it ends by itself within ${PASS_HOURS} hours).`
                : "No acceptance pass."}
            </dd>
          </div>
          <div className={ROW}>
            <dt className="text-gray-600">Published products</dt>
            <dd>{facts.publishedProducts}</dd>
          </div>
          <div className={ROW}>
            <dt className="text-gray-600">Delivery areas with a charge</dt>
            <dd>{facts.activeZones} of 2</dd>
          </div>
          <div className={ROW}>
            <dt className="text-gray-600">Published policies</dt>
            <dd data-testid="policies-state">
              {policies.length
                ? policies
                    .map((p) => `${p.kind} (${formatTime(p.publishedAt)})`)
                    .join(", ")
                : "None"}
            </dd>
          </div>
        </dl>
        <details className="text-sm">
          <summary className="cursor-pointer py-3 font-semibold lg:py-1">
            Technical details (for the person who sets up the website)
          </summary>
          <dl className="mt-2 divide-y divide-gray-200">
            <div className={ROW}>
              <dt className="text-gray-600">Database update 0020</dt>
              <dd data-testid="schema-state">
                {facts.schemaReady
                  ? "Applied"
                  : "Not applied: run the staging migration first (docs/operations/acceptance.md, step 2)."}
              </dd>
            </div>
            <div className={ROW}>
              <dt className="text-gray-600">Continue with Google</dt>
              <dd>
                {customerSignInAvailable()
                  ? "Offered to shoppers"
                  : "Not offered (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not set or invalid)"}
              </dd>
            </div>
            <div className={ROW}>
              <dt className="text-gray-600">Per-client checkout limit</dt>
              <dd>
                {settingState(
                  () => trustedClientHeaders(process.env).length,
                ) === "set"
                  ? "On (TRUSTED_PROXY=netlify)"
                  : settingState(
                        () => trustedClientHeaders(process.env).length,
                      ) === "invalid"
                    ? "TRUSTED_PROXY is invalid"
                    : "Off (TRUSTED_PROXY not set): only the storewide limit applies"}
              </dd>
            </div>
            <div className={ROW}>
              <dt className="text-gray-600">Image CDN (Cloudinary)</dt>
              <dd>
                {cdn.ok
                  ? cdn.config
                    ? "Configured: published photos are copied there"
                    : "Not configured: photos are served by the site"
                  : "Settings incomplete or invalid"}
              </dd>
            </div>
          </dl>
        </details>
      </Section>

      <Section title="In this browser">
        {facts.staging && !facts.schemaReady ? (
          <p className="text-sm text-gray-700">
            Apply the staging migration (database update 0020) before starting
            acceptance.
          </p>
        ) : facts.staging ? (
          <div className="flex flex-wrap items-start gap-3">
            {mine ? null : (
              <ActionForm
                action={startAcceptanceAction}
                idempotencyKey={randomUUID()}
                submitLabel="Start acceptance in this browser"
              />
            )}
            {pass ? (
              <ActionForm
                action={endAcceptanceAction}
                idempotencyKey={randomUUID()}
                submitLabel="End acceptance in this browser"
                variant="secondary"
              />
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-gray-700">
            Acceptance cannot start: this is not the staging database.
          </p>
        )}
        {mine ? (
          <div className="flex flex-wrap gap-2">
            <Link
              href="/en"
              className="of-btn of-btn-primary"
              data-testid="open-shop-en"
            >
              Open the shop in English
            </Link>
            <Link
              href="/bn"
              className="of-btn of-btn-line"
              data-testid="open-shop-bn"
            >
              Open the shop in Bangla
            </Link>
          </div>
        ) : null}
        <p className="text-xs text-gray-600">
          To shop as a separate customer, start acceptance in a private window
          too: sign in there, start acceptance, then sign out of Admin. The pass
          stays until it ends by itself or you end it.
        </p>
      </Section>

      <Section title="The rehearsal, step by step">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>
            Create a product, add its sizes and prices, its photos and the
            readiness items; receive stock.
          </li>
          <li>
            Mark its content as reviewed, then publish it from its page (the
            proposed rule applies here only).
          </li>
          <li>
            Open the shop above, find the product, add it to the bag and check
            out as a guest or with Google.
          </li>
          <li>Keep the tracking link shown once on the confirmation.</li>
          <li>
            In Orders: verify the customer by phone, then confirm, pack,
            dispatch and record the delivery and the cash.
          </li>
          <li>
            Check the stock, the order history, the tracking page and the
            reports.
          </li>
          <li>Read Launch readiness before any public launch decision.</li>
        </ol>
      </Section>
    </AdminShell>
  );
}
