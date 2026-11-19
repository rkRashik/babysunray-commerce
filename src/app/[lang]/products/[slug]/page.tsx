import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { ProductView } from "@/app/admin/storefront-preview/_components/views/product-view";
import { getDb } from "@/db/client";
import { publishedPolicies } from "@/modules/policies/publication";
import { isLang } from "@/modules/storefront/i18n";
import { PUBLIC_SCOPE } from "@/modules/storefront/service";

type Props = { params: Promise<{ lang: string; slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

// A published product; any other slug (unknown, draft, withdrawn, archived) is the same 404.
export default async function ShopProduct({ params, searchParams }: Props) {
  const { lang, slug } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  const from = (await searchParams).from;
  const policies = (await publishedPolicies(getDb())).filter((p) => p.kind === "delivery" || p.kind === "returns").map((p) => ({ kind: p.kind, href: `/${lang}/policies/${p.kind}` }));
  return <ProductView lang={lang} surface="shop" scope={PUBLIC_SCOPE} slug={slug} from={typeof from === "string" ? from : null} policies={policies} />;
}
