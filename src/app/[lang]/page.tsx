import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { HomeView } from "@/app/office/storefront-preview/_components/views/home-view";
import { isLang } from "@/modules/storefront/i18n";
import { PUBLIC_SCOPE } from "@/modules/storefront/service";

export default async function ShopHome({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  return <HomeView lang={lang} surface="shop" scope={PUBLIC_SCOPE} />;
}
