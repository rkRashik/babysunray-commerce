import { notFound } from "next/navigation";
import { isLang } from "@/modules/storefront/i18n";
import { PREVIEW_SCOPE } from "@/modules/storefront/service";
import { requireAdmin } from "../../_lib/session";
import { HomeView } from "../_components/views/home-view";

export default async function PreviewHome({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireAdmin("storefront:preview");
  return <HomeView lang={lang} surface="preview" scope={PREVIEW_SCOPE} />;
}
