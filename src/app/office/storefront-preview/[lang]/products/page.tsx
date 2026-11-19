import { notFound } from "next/navigation";
import { isLang } from "@/modules/storefront/i18n";
import { PREVIEW_SCOPE } from "@/modules/storefront/service";
import { requireOffice } from "../../../_lib/session";
import { ProductsView } from "../../_components/views/products-view";

type Props = { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function PreviewProducts({ params, searchParams }: Props) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireOffice("storefront:preview");
  return <ProductsView lang={lang} surface="preview" scope={PREVIEW_SCOPE} query={await searchParams} />;
}
