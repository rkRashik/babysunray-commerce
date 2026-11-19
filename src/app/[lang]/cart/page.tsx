import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { CartView } from "@/app/office/storefront-preview/_components/cart-view";
import { dictionary, isLang } from "@/modules/storefront/i18n";

export default async function ShopCart({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  const t = dictionary(lang);
  return (
    <div className="space-y-4 lg:space-y-6">
      <h1 className="sf-display text-[2.125rem] lg:text-[3.25rem]">{t.cartTitle}</h1>
      <CartView lang={lang} />
    </div>
  );
}
