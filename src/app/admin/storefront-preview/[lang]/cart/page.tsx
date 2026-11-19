import { notFound } from "next/navigation";
import { dictionary, isLang } from "@/modules/storefront/i18n";
import { requireAdmin } from "../../../_lib/session";
import { CartView } from "../../_components/cart-view";

export default async function PreviewCart({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireAdmin("storefront:preview");
  const t = dictionary(lang);
  return (
    <div className="space-y-4 lg:space-y-6">
      <h1 className="sf-display text-[2.125rem] lg:text-[3.25rem]">{t.cartTitle}</h1>
      <CartView lang={lang} />
    </div>
  );
}
