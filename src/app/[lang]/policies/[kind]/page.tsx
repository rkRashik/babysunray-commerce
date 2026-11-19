import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { getDb } from "@/db/client";
import { publishedPolicy } from "@/modules/policies/publication";
import { dictionary, isLang, toBnDigits } from "@/modules/storefront/i18n";

// A customer policy exactly as the founder approved and published it (src/modules/policies/publication.ts), as plain text.
// Not published (never, or withdrawn): 404, so no placeholder is ever shown as if it were the policy.
export default async function ShopPolicy({ params }: { params: Promise<{ lang: string; kind: string }> }) {
  const { lang, kind } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  const policy = await publishedPolicy(getDb(), kind);
  if (!policy) notFound();
  const t = dictionary(lang);
  const date = new Intl.DateTimeFormat(lang === "bn" ? "bn-BD" : "en-GB", { dateStyle: "long", timeZone: "Asia/Dhaka" }).format(policy.publishedAt);
  return (
    <article className="mx-auto max-w-prose space-y-6 pt-2" data-testid="policy">
      <h1 className="sf-display text-[2.25rem] lg:text-[3rem]">{t.policyNames[policy.kind]}</h1>
      <p className="text-[0.9375rem] text-sf-ink-2">{lang === "bn" ? toBnDigits(date) : date}</p>
      <div className="whitespace-pre-line leading-relaxed">{lang === "bn" ? policy.bodyBn : policy.bodyEn}</div>
    </article>
  );
}
