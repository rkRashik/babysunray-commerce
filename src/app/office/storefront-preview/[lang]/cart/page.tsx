import { notFound } from "next/navigation";
import { dictionary, isLang } from "@/modules/storefront/i18n";
import { requireOffice } from "../../../_lib/session";
import { CartView } from "../../_components/cart-view";

export default async function PreviewCart({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireOffice("storefront:preview");
  const t = dictionary(lang);
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold">{t.cartTitle}</h1>
      <CartView lang={lang} />
    </div>
  );
}
