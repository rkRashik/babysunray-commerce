import { notFound } from "next/navigation";
import { isLang } from "@/modules/storefront/i18n";
import { requireAdmin } from "../../../_lib/session";
import { CheckoutForm } from "../../_components/checkout-form";

// Checkout prototype. Simulation only: public checkout stays disabled until the founder approves and publishes
// the delivery, return/exchange and privacy policies (S-17, G-7). No order, reservation or message results.
export default async function PreviewCheckout({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireAdmin("storefront:preview");
  // The form renders the page heading (a confirmation replaces it with its own).
  return <CheckoutForm lang={lang} />;
}
