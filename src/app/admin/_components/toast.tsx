"use client";

import { CheckCircle2, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * A short confirmation of something the server has already done (the page's `done` notice). It is announced politely,
 * stays long enough to read, can be dismissed, and never carries a promise: it is only shown after the server answered.
 */
export function Toast({ message }: { message: string }) {
  // Each answer (a new address or text) is a new notice, even when the words are the same as the last one.
  const key = `${usePathname()}?${useSearchParams()}|${message}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDismissed(key), 9000);
    return () => clearTimeout(timer);
  }, [key]);
  if (dismissed === key) return null;
  return (
    <div role="status" className="of-toast">
      <CheckCircle2 aria-hidden="true" size={18} strokeWidth={2} className="mt-0.5 shrink-0 text-green-700" />
      <p className="min-w-0 flex-1 text-sm font-semibold">{message}</p>
      <button type="button" aria-label="Dismiss" className="of-toast-close" onClick={() => setDismissed(key)}>
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}
