import { randomUUID } from "node:crypto";
import { Check, ImageOff } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { formatCentimetres, MEASUREMENT_POINTS } from "@/modules/catalogue/content";
import { publicationHistory, publicationRuleFor, publicationState } from "@/modules/catalogue/publication";
import { evaluateReadiness, READINESS_ITEMS } from "@/modules/catalogue/readiness";
import { reviewHistory, reviewStates } from "@/modules/catalogue/review";
import { getProductWithVariants } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { getStockLevel } from "@/modules/inventory/service";
import { archiveProductAction, createVariantAction, deactivateVariantAction, publishProductAction, reviewProductAction, withdrawProductAction } from "../../actions";
import { ActionForm, Field } from "../../_components/action-form";
import { Bilingual, ReadinessList } from "../../_components/content";
import { ActionPanel } from "../../_components/panel";
import { MEASUREMENT_LABELS } from "../../_lib/labels";
import { AdminShell, Section, formatTime, noticeFor, productTitle, sectionId } from "../../_components/shell";
import { requireAdmin } from "../../_lib/session";
import { bdt } from "../../orders/_components/labels";
import { ScrollArea } from "../../_components/scroll-area";

export const metadata = { title: "Product · Admin" };

type Props = { params: Promise<{ productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const BUTTON_LINK = "of-btn of-btn-line min-h-11 px-3.5 text-sm lg:min-h-10";

/** Why a product cannot be published, in the Owner's words (codes from publicationBlockers). */
function blockerText(code: string): string {
  if (code === "no_approved_rule") return "Publishing is off until you approve your publication requirements (Settings, Publication requirements).";
  if (code === "not_draft") return "Only a draft can be published.";
  if (code === "review_not_current") return "Mark the current content as reviewed (step 2).";
  const item = READINESS_ITEMS.find((i) => `item:${i.id}` === code);
  return item ? `Missing: ${item.label}.` : code;
}

/** Where to fix a publication blocker: the page or part of this page that does it, in the Owner's words. */
function nextAction(code: string, productId: string): { text: string; action: string; href: string } {
  const edit = `/admin/products/${productId}/edit`;
  const photos = `/admin/products/${productId}/photos`;
  const variants = `#${sectionId("Variants and stock")}`;
  const map: Record<string, { text: string; action: string; href: string }> = {
    review_not_current: { text: "mark the current content as reviewed.", action: "Go to the review", href: `#${sectionId("Publishing")}` },
    "item:name": { text: "add the product name in English and Bangla.", action: "Edit the name", href: edit },
    "item:description": { text: "add the description in English and Bangla.", action: "Edit the description", href: edit },
    "item:fabric": { text: "add and confirm the fabric statement.", action: "Edit the fabric", href: edit },
    "item:care": { text: "add the care instructions in English and Bangla.", action: "Edit the care instructions", href: edit },
    "item:category": { text: "choose a category.", action: "Choose a category", href: edit },
    "item:measurements": { text: "add the size chart measurements.", action: "Add measurements", href: `/admin/products/${productId}/measurements` },
    "item:photo": { text: "add a product photo.", action: "Add photos", href: photos },
    "item:alt": { text: "describe each photo in English and Bangla.", action: "Describe photos", href: photos },
    "item:variant": { text: "add a variant with a price.", action: "Go to variants", href: variants },
    "item:sizes": { text: "give every active variant a size.", action: "Go to variants", href: variants },
  };
  return map[code] ?? { text: "finish the publishing checklist.", action: "See what is missing", href: `#${sectionId("Publishing")}` };
}

/** One numbered publishing step; a finished step shows a tick instead of its number. */
function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3" data-step={n} data-done={done}>
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-green-700 text-white" : "bg-[var(--color-sf-mist)] text-gray-900 ring-1 ring-[var(--color-sf-line-strong)]"}`}
      >
        {done ? <Check size={16} strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0 space-y-3">
        <h3 className="pt-1 font-bold">
          {title} <span className="sr-only">{done ? "(done)" : "(not done)"}</span>
        </h3>
        {children}
      </div>
    </li>
  );
}

export default async function ProductPage({ params, searchParams }: Props) {
  await requireAdmin("catalog:read", "stock:read");
  const { productId } = await params;
  const db = getDb();
  const product = await getProductWithVariants(db, productId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "PRODUCT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const [stock, reviews, history, rule, published, { done }] = await Promise.all([
    Promise.all(product.variants.map((v) => getStockLevel(db, v.sku))),
    reviewStates(db, [product.id]),
    reviewHistory(db, product.id),
    publicationRuleFor(db),
    publicationHistory(db, product.id),
    searchParams,
  ]);
  const review = reviews.get(product.id);
  const publication = await publicationState(db, product.id, rule);
  const draft = product.status === "draft";
  const { title, lang } = productTitle(product);

  const active = product.variants.filter((v) => v.status === "active");
  // On hand counts every variant; available counts the active ones only, since an inactive variant cannot be ordered.
  const onHand = stock.reduce((n, s) => n + s.onHand, 0);
  const available = stock.reduce((n, s, i) => n + (product.variants[i].status === "active" ? s.available : 0), 0);
  const itemsLeft = publication.blockers.filter((b) => b.startsWith("item:") || b === "review_not_current").length;
  // The first thing publishing still needs, as one direct action: missing information first, since a review of content
  // that is still changing goes out of date; then the review.
  const first = nextAction(publication.blockers.find((b) => b.startsWith("item:")) ?? publication.blockers.find((b) => b === "review_not_current") ?? "", product.id);
  const cover = product.media[0];
  // A variant's actions, the same in the table and in the phone cards.
  const variantActions = (v: (typeof product.variants)[number], card: boolean) =>
    v.status === "active" ? (
      <div className={`flex flex-wrap items-start gap-2 ${card ? "justify-start" : "justify-end"}`}>
        {/* In the table the SKU itself links to its stock; a card gets a button for it. */}
        {card ? (
          <Link href={`/admin/skus/${encodeURIComponent(v.sku)}`} className="of-btn of-btn-line of-btn-sm" aria-label={`Stock of ${v.sku}`}>
            Stock
          </Link>
        ) : null}
        {draft ? (
          <Link href={`/admin/variants/${v.id}/edit`} className="of-btn of-btn-line of-btn-sm" aria-label={`Edit ${v.sku}`}>
            Edit
          </Link>
        ) : null}
        <ActionForm
          action={deactivateVariantAction}
          idempotencyKey={randomUUID()}
          hidden={{ variantId: v.id }}
          submitLabel="Deactivate"
          variant="secondary"
          compact
          confirm={`Deactivate ${v.sku}? It keeps its stock and history, but there is no way to reactivate it here.`}
        />
      </div>
    ) : null;
  // In page order: photos first (what customers see first), then stock, publishing and the details.
  const jump = ["Photos", "Size chart (cm)", "Variants and stock", "Publishing", "Details"];

  return (
    <AdminShell
      title={title}
      titleLang={lang}
      notice={noticeFor(done)}
      breadcrumbs={[{ href: "/admin", label: "Products" }]}
      actions={
        <>
          <Link href={`/admin/storefront-preview/en/products/${product.slug}`} className="of-btn of-btn-line">
            View in storefront preview
          </Link>
          {draft ? (
            <Link href={`/admin/products/${product.id}/edit`} className="of-btn of-btn-primary">
              Edit details
            </Link>
          ) : null}
        </>
      }
    >
      {/* At a glance: what this product is, whether customers see it, its stock, and the one thing to do next. */}
      <section aria-label="Overview" className="of-card flex gap-4 p-4 sm:gap-6 sm:p-5 lg:p-6">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-gray-200 bg-[var(--color-sf-mist)] sm:h-32 sm:w-32">
          {cover ? (
            // Private photos come from the Owner-only media route; Next.js image optimisation would fetch them without the session.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/admin/media/${cover.id}?w=320`} alt={cover.altEn ?? "First product photo (no English description yet)"} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-gray-600">
              <ImageOff aria-hidden="true" size={22} />
              No photo yet
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <p className="flex flex-wrap items-center gap-2" data-testid="product-status">
            <span className="of-pill" data-tone={draft ? "wait" : product.status === "published" ? "ok" : "quiet"}>
              {product.status.charAt(0).toUpperCase() + product.status.slice(1)}
            </span>
            <span className="text-sm text-gray-700">{draft ? "Not shown to customers" : product.status === "published" ? "In the shop; cannot be edited" : "Never shown to customers; cannot be edited"}</span>
          </p>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="product-glance">
            <div>
              <dt className="inline text-gray-600">Variants: </dt>
              <dd className="inline font-semibold tabular-nums">
                {active.length} active{product.variants.length > active.length ? ` of ${product.variants.length}` : ""}
              </dd>
            </div>
            <div>
              <dt className="inline text-gray-600">On hand: </dt>
              <dd className="inline font-semibold tabular-nums">{onHand}</dd>
            </div>
            <div>
              <dt className="inline text-gray-600">Available for orders: </dt>
              <dd className="inline font-semibold tabular-nums">{available}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-gray-200 pt-3 text-sm" data-testid="next-step">
            {product.status === "published" ? (
              <>
                <span>Customers who can open the shop see this product.</span>
                <Link href={`/en/products/${product.slug}`} className={BUTTON_LINK}>
                  Open in the shop
                </Link>
              </>
            ) : product.status === "archived" ? (
              <span>Archived products stay in your records only.</span>
            ) : publication.blockers.includes("no_approved_rule") ? (
              <>
                <span>Publishing is off until you approve your publication requirements.</span>
                <Link href="/admin/settings/publication" className={BUTTON_LINK}>
                  Publication requirements
                </Link>
              </>
            ) : publication.blockers.length === 0 ? (
              <>
                <span className="font-semibold">Ready to publish.</span>
                <Link href={`#${sectionId("Publishing")}`} className="of-btn of-btn-primary min-h-11 px-3.5 text-sm lg:min-h-10">
                  Go to publishing
                </Link>
              </>
            ) : (
              <>
                <span className="w-full">
                  <span className="font-semibold">Next: {first.text}</span>
                  <span className="text-gray-700">
                    {" "}
                    ({itemsLeft} {itemsLeft === 1 ? "thing" : "things"} left before you can publish)
                  </span>
                </span>
                <Link href={first.href} className="of-btn of-btn-primary min-h-11 px-3.5 text-sm lg:min-h-10">
                  {first.action}
                </Link>
                {itemsLeft > 1 && !first.href.startsWith("#section-publishing") ? (
                  <Link href={`#${sectionId("Publishing")}`} className={BUTTON_LINK}>
                    See all {itemsLeft}
                  </Link>
                ) : null}
              </>
            )}
          </div>
        </div>
      </section>

      <ScrollArea label="Sections of this page" fade>
        <nav aria-label="On this page">
          <ul className="flex gap-2">
            {jump.map((s) => (
              <li key={s} className="shrink-0">
                <a href={`#${sectionId(s)}`} className="of-chip">
                  {s === "Size chart (cm)" ? "Size chart" : s}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </ScrollArea>

      <PhotosAndSizes product={product} draft={draft} />

      <Section title="Variants and stock">
        {product.variants.length === 0 ? (
          <p className="text-sm text-gray-700">No variants yet. Each variant is one size or colour, with its own SKU, price and stock. Add the first one below.</p>
        ) : (
          <>
            <p className="text-sm text-gray-700">Select a SKU to receive or adjust its stock. Available is what new orders can still take: on hand minus units reserved for orders.</p>
            <div className="hidden overflow-hidden rounded-xl border border-gray-200 md:block">
              <ScrollArea label="Variants table" hint="Scroll sideways for more columns. The actions stay in view.">
                <table className="of-table">
                  <thead>
                    <tr>
                      <th scope="col">SKU</th>
                      <th scope="col">Size and colour</th>
                      <th scope="col" className="num">
                        Price
                      </th>
                      <th scope="col" className="num">
                        Available
                      </th>
                      <th scope="col" className="num">
                        On hand
                      </th>
                      <th scope="col">Status</th>
                      <th scope="col" className="of-sticky-end">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {product.variants.map((v, i) => (
                      <tr key={v.id}>
                        <th scope="row" className="font-normal">
                          <Link href={`/admin/skus/${encodeURIComponent(v.sku)}`} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4 lg:min-h-0">
                            {v.sku}
                          </Link>
                        </th>
                        <td>{[v.size, v.colour].filter(Boolean).join(" · ") || <span className="text-gray-500">Not set</span>}</td>
                        <td className="num">{bdt(v.pricePaisa)}</td>
                        <td className="num">
                          <span className={`font-semibold ${stock[i].available === 0 && v.status === "active" ? "text-red-800" : ""}`}>{stock[i].available}</span>
                          {stock[i].reserved > 0 ? <span className="block text-xs text-gray-600">{stock[i].reserved} reserved</span> : null}
                        </td>
                        <td className="num">{stock[i].onHand}</td>
                        <td>
                          <span className="of-pill" data-tone={v.status === "active" ? "ok" : "quiet"}>
                            {v.status === "active" ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="of-sticky-end">{variantActions(v, false)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </div>
            {/* On a phone: one card per variant, with its stock figures and actions, instead of a sideways-scrolling table. */}
            <ul aria-label="Variants" className="space-y-3 md:hidden">
              {product.variants.map((v, i) => (
                <li key={v.id} className="rounded-xl border border-gray-200 p-3.5" data-variant={v.sku}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/admin/skus/${encodeURIComponent(v.sku)}`} className="inline-flex min-h-11 items-center font-semibold break-all underline underline-offset-4">
                        {v.sku}
                      </Link>
                      <p className="text-sm text-gray-700">
                        {[v.size, v.colour].filter(Boolean).join(" · ") || "No size or colour"} · {bdt(v.pricePaisa)}
                      </p>
                    </div>
                    <span className="of-pill shrink-0" data-tone={v.status === "active" ? "ok" : "quiet"}>
                      {v.status === "active" ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
                    {(
                      [
                        ["Available", stock[i].available],
                        ["Reserved", stock[i].reserved],
                        ["On hand", stock[i].onHand],
                      ] as const
                    ).map(([term, n]) => (
                      <div key={term} className="rounded-lg bg-[var(--color-sf-mist)] px-2 py-1.5">
                        <dt className="text-xs text-gray-600">{term}</dt>
                        <dd className={`font-bold tabular-nums ${term === "Available" && n === 0 && v.status === "active" ? "text-red-800" : ""}`}>{n}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-3">{variantActions(v, true)}</div>
                </li>
              ))}
            </ul>
          </>
        )}
        <ActionPanel key={`variant-${product.variants.length}`} label="Add a variant" open={product.variants.length === 0}>
          <ActionForm action={createVariantAction} idempotencyKey={randomUUID()} hidden={{ productId: product.id }} submitLabel="Add variant">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field name="sku" label="SKU" required maxLength={64} hint="Your code for this size and colour. Letters A-Z, digits, hyphen and underscore; stored in capitals; must be unique. Cannot be changed later." />
              </div>
              <Field name="size" label="Size" maxLength={64} />
              <Field name="colour" label="Colour" maxLength={64} />
              <Field name="priceTaka" label="Price (BDT)" required inputMode="decimal" hint="In Taka, for example 850 or 850.50. Stored exactly in paisa." />
            </div>
          </ActionForm>
        </ActionPanel>
      </Section>

      <Section title="Publishing">
        <p className="text-sm" data-testid="publication-state">
          {product.status === "published"
            ? "Published: customers who can open the shop see this product. It cannot be edited until you withdraw it."
            : product.status === "archived"
              ? "Archived: never shown to customers."
              : "Draft: not shown to customers."}
        </p>
        <ol className="space-y-6">
          <Step n={1} title="Complete the product information" done={!publication.blockers.some((b) => b.startsWith("item:"))}>
            <ReadinessList items={evaluateReadiness(product)} rule={rule} />
          </Step>
          <Step n={2} title="Mark the content as reviewed" done={Boolean(review?.current)}>
            <p className="text-sm" data-testid="review-state">
              {!review?.reviewedAt
                ? "Not reviewed yet."
                : review.current
                  ? `Reviewed on ${formatTime(review.reviewedAt)}; the content has not changed since.`
                  : `Outdated: reviewed on ${formatTime(review.reviewedAt)}, and the content (text, claims, sizes, photos, SKUs or prices) has changed since.`}
            </p>
            <p className="text-xs text-gray-600">A review records that you checked this content as it is now. It does not publish the product or make it visible to anyone.</p>
            {draft && !review?.current && review ? (
              <ActionForm action={reviewProductAction} idempotencyKey={randomUUID()} hidden={{ productId: product.id, contentSha256: review.contentSha256 }} submitLabel="Mark the current content as reviewed" variant="secondary" />
            ) : null}
            {history.length ? (
              <details className="text-sm">
                <summary className="cursor-pointer py-3 font-medium lg:py-0">Review history ({history.length})</summary>
                <ul className="mt-2 space-y-1">
                  {history.map((h) => (
                    <li key={h.id}>
                      {formatTime(h.createdAt)} by the Owner{(h.openItems as string[]).length ? ` · open then: ${(h.openItems as string[]).join(", ")}` : " · nothing open"}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Step>
          <Step n={3} title={product.status === "published" ? "In the shop" : "Publish to the shop"} done={product.status === "published"}>
            <p className="text-xs text-gray-600" data-testid="publication-rule">
              {rule === null
                ? "Publishing is off until you approve your publication requirements (Settings, Publication requirements)."
                : rule.id === "i6-proposed-acceptance"
                  ? "Test shop (staging database): a trial set of requirements applies (every checklist item above and a current review). It is not your approved set; each publication records it."
                  : "Your approved publication requirements apply."}
            </p>
            {draft && publication.blockers.length ? (
              <div className="rounded-xl bg-[var(--color-sf-warn-soft)] px-4 py-3 text-sm text-[var(--color-sf-warn)]">
                <p className="font-semibold text-gray-900">Not yet: {publication.blockers.length === 1 ? "1 thing is" : `${publication.blockers.length} things are`} still needed.</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-gray-900" data-testid="publication-blockers">
                  {publication.blockers.map((b) => (
                    <li key={b}>{blockerText(b)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {draft && publication.blockers.length === 0 ? (
              <ActionForm
                action={publishProductAction}
                idempotencyKey={randomUUID()}
                hidden={{ productId: product.id, contentSha256: publication.contentSha256 }}
                submitLabel="Publish to the shop"
                confirm="Publish this product exactly as it is now? Customers who can open the shop will see it at once."
              />
            ) : null}
            {product.status === "published" ? (
              <div className="flex flex-wrap items-start gap-2">
                <Link href={`/en/products/${product.slug}`} className={BUTTON_LINK}>
                  Open in the shop
                </Link>
                <ActionForm
                  action={withdrawProductAction}
                  idempotencyKey={randomUUID()}
                  hidden={{ productId: product.id, version: String(product.version) }}
                  submitLabel="Withdraw from the shop"
                  variant="secondary"
                  confirm="Withdraw this product? It leaves the shop at once and becomes an editable draft. Orders and stock are not changed."
                />
              </div>
            ) : null}
            {published.length ? (
              <details className="text-sm">
                <summary className="cursor-pointer py-3 font-medium lg:py-0">Publication history ({published.length})</summary>
                <ul className="mt-2 space-y-1">
                  {published.map((e) => (
                    <li key={e.id}>
                      {formatTime(e.createdAt)}: {e.event}
                      {e.ruleId ? ` under ${e.ruleId === "i6-proposed-acceptance" ? "the proposed rule (acceptance)" : e.ruleId}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Step>
        </ol>
      </Section>

      <Section title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-gray-600">Web address</dt>
          <dd className="break-all">{product.slug}</dd>
          <Bilingual label="Name" en={product.nameEn} bn={product.nameBn} />
          <Bilingual label="Description" en={product.descriptionEn} bn={product.descriptionBn} />
          <Bilingual label="Fabric" en={product.fabricEn} bn={product.fabricBn} />
          <dt className="text-gray-600">Fabric statement</dt>
          <dd data-testid="fabric-confirmation">{product.fabricConfirmedAt ? `Confirmed by you on ${formatTime(product.fabricConfirmedAt)}` : "Not confirmed"}</dd>
          <Bilingual label="Care" en={product.careEn} bn={product.careBn} />
          <Bilingual label="Size guidance (optional)" en={product.sizeGuidanceEn} bn={product.sizeGuidanceBn} />
          <dt className="text-gray-600">Category</dt>
          <dd>{product.category ? (product.category.nameEn ?? <span lang="bn">{product.category.nameBn}</span>) : "—"}</dd>
          <dt className="text-gray-600">Featured</dt>
          <dd>{product.featured ? "Yes (shown first in the storefront preview)" : "No"}</dd>
          <dt className="text-gray-600">Created</dt>
          <dd>{formatTime(product.createdAt)}</dd>
          <dt className="text-gray-600">Last changed</dt>
          <dd>{formatTime(product.updatedAt)}</dd>
        </dl>
      </Section>

      {draft ? (
        <ActionPanel label="Archive this product" danger>
          <p className="text-sm text-gray-700">
            Archiving keeps the product, its variants and their stock history. Nothing is deleted, but an archived product can no longer be edited and there is no way to
            undo archiving here.
          </p>
          <ActionForm
            action={archiveProductAction}
            idempotencyKey={randomUUID()}
            hidden={{ productId: product.id }}
            submitLabel="Archive product"
            variant="secondary"
            confirm="Archive this product? It can no longer be edited afterwards, and archiving cannot be undone here."
          />
        </ActionPanel>
      ) : null}
    </AdminShell>
  );
}

/** Photos first (what customers see first), then the size chart: placed right under the overview. */
function PhotosAndSizes({ product, draft }: { product: Awaited<ReturnType<typeof getProductWithVariants>>; draft: boolean }) {
  return (
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Section
          title="Photos"
          action={
            <Link href={`/admin/products/${product.id}/photos`} className={BUTTON_LINK}>
              {draft ? "Manage photos" : "View photos"}
            </Link>
          }
        >
          {product.media.length === 0 ? (
            <p className="text-sm text-gray-700">No photos yet. The first photo is the one customers see first.</p>
          ) : (
            <ul className="flex flex-wrap gap-3" aria-label="Photos">
              {product.media.map((m) => (
                <li key={m.id}>
                  {/* Private photos are served by an Owner-only route; Next.js image optimisation would fetch them without the session. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/admin/media/${m.id}?w=320`} alt={m.altEn ?? "Product photo (no English description yet)"} width={120} height={Math.round((120 * m.height) / m.width)} className="rounded border border-gray-300 bg-gray-100 object-cover" />
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section
          title="Size chart (cm)"
          action={
            draft ? (
              <Link href={`/admin/products/${product.id}/measurements`} className={BUTTON_LINK}>
                Edit size chart
              </Link>
            ) : null
          }
        >
          {product.measurements.length === 0 ? (
            <p className="text-sm text-gray-700">No measurements yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-left text-sm">
                <thead className="border-b border-gray-300 text-gray-600">
                  <tr>
                    <th scope="col" className="py-2 pr-4">
                      Size
                    </th>
                    {MEASUREMENT_POINTS.filter((p) => product.measurements.some((m) => m.point === p)).map((p) => (
                      <th key={p} scope="col" className="py-2 pr-4 text-right">
                        {MEASUREMENT_LABELS[p]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {[...new Set(product.measurements.map((m) => m.size))].map((size) => (
                    <tr key={size}>
                      <th scope="row" className="py-2 pr-4 font-normal">
                        {size}
                      </th>
                      {MEASUREMENT_POINTS.filter((p) => product.measurements.some((m) => m.point === p)).map((p) => {
                        const m = product.measurements.find((x) => x.size === size && x.point === p);
                        return (
                          <td key={p} className="py-2 pr-4 text-right tabular-nums">
                            {m ? formatCentimetres(m.valueMm) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
  );
}
