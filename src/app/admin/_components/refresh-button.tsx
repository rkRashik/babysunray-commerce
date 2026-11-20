"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Re-reads the page's figures from the server without a full reload (scroll position and open forms stay). */
export function RefreshButton({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="of-btn of-btn-line of-btn-sm" onClick={() => start(() => router.refresh())} disabled={pending} aria-live="polite">
      <RefreshCw aria-hidden="true" size={16} className={pending ? "animate-spin" : undefined} />
      {pending ? "Refreshing…" : label}
    </button>
  );
}
