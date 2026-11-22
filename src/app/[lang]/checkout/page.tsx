import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { CheckoutForm } from "@/app/admin/storefront-preview/_components/checkout-form";
import { isLang } from "@/modules/storefront/i18n";

// The real checkout: the last step places a Cash on Delivery order through POST /api/shop/checkout (src/api/guest-checkout.ts).
export default async function ShopCheckout({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  // The form renders the page heading (a confirmation replaces it with its own).
  return <CheckoutForm lang={lang} />;
}
