import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { ProductsView } from "@/app/admin/storefront-preview/_components/views/products-view";
import { isLang } from "@/modules/storefront/i18n";
import { PUBLIC_SCOPE } from "@/modules/storefront/service";

type Props = { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ShopProducts({ params, searchParams }: Props) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  return <ProductsView lang={lang} surface="shop" scope={PUBLIC_SCOPE} query={await searchParams} />;
}
