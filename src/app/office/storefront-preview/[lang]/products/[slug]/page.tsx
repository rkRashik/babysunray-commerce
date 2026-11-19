import { notFound } from "next/navigation";
import { isLang } from "@/modules/storefront/i18n";
import { PREVIEW_SCOPE } from "@/modules/storefront/service";
import { requireOffice } from "../../../../_lib/session";
import { ProductView } from "../../../_components/views/product-view";

type Props = { params: Promise<{ lang: string; slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function PreviewProduct({ params, searchParams }: Props) {
  const { lang, slug } = await params;
  if (!isLang(lang)) notFound();
  await requireOffice("storefront:preview");
  const from = (await searchParams).from;
  return <ProductView lang={lang} surface="preview" scope={PREVIEW_SCOPE} slug={slug} from={typeof from === "string" ? from : null} />;
}
