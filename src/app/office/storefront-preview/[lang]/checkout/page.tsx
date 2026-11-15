import { notFound } from "next/navigation";
import { dictionary, isLang } from "@/modules/storefront/i18n";
import { requireOffice } from "../../../_lib/session";
import { CheckoutForm } from "../../_components/checkout-form";

// Checkout prototype. Simulation only: public checkout stays disabled until the founder approves and publishes
// the delivery, return/exchange and privacy policies (S-17, G-7). No order, reservation or message results.
export default async function PreviewCheckout({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireOffice("storefront:preview");
  const t = dictionary(lang);
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">{t.checkoutTitle}</h1>
      <CheckoutForm lang={lang} />
    </div>
  );
}
