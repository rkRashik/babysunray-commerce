"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { dictionary, isLang } from "@/modules/storefront/i18n";

// An unexpected failure inside the preview. The error itself is never shown.
export default function PreviewError({ reset }: { reset: () => void }) {
  const params = useParams<{ lang: string }>();
  const t = dictionary(isLang(params.lang) ? params.lang : "en");
  return (
    <div role="alert" className="max-w-xl space-y-4 py-12">
      <h1 className="text-2xl font-semibold">{t.errorTitle}</h1>
      <p>{t.errorBody}</p>
      <div className="flex flex-wrap gap-4">
        <button type="button" onClick={reset} className="min-h-11 rounded-sm bg-sf-cocoa px-5 font-semibold text-sf-ivory">
          {t.tryAgain}
        </button>
        <Link href="/office" className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
          {t.backToOffice}
        </Link>
      </div>
    </div>
  );
}
