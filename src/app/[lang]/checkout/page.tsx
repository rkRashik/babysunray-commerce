import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { CheckoutForm } from "@/app/admin/storefront-preview/_components/checkout-form";
import { dictionary, isLang } from "@/modules/storefront/i18n";

// The real checkout: the last step places a Cash on Delivery order through POST /api/shop/checkout (src/api/guest-checkout.ts).
export default async function ShopCheckout({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  const t = dictionary(lang);
  return (
    <div className="space-y-4 lg:space-y-8">
      <h1 className="sf-display text-[2.125rem] lg:text-[3.25rem]">{t.checkoutTitle}</h1>
      <CheckoutForm lang={lang} />
    </div>
  );
}
