"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { dictionary, isLang } from "@/modules/storefront/i18n";

// An unexpected failure inside the preview. The error itself is never shown.
export default function PreviewError({ reset }: { reset: () => void }) {
  const params = useParams<{ lang: string }>();
  const t = dictionary(isLang(params.lang) ? params.lang : "en");
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-5 py-14 text-center">
      <span aria-hidden="true" className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-sf-danger-soft text-sf-danger">
        <RotateCcw size={28} strokeWidth={1.5} />
      </span>
      <h1 className="text-[1.75rem]">{t.errorTitle}</h1>
      <p className="text-sf-ink-2">{t.errorBody}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <button type="button" onClick={reset} className="sf-btn">
          {t.tryAgain}
        </button>
        <Link href="/admin" className="sf-btn sf-btn-ghost">
          {t.backToAdmin}
        </Link>
      </div>
    </div>
  );
}
