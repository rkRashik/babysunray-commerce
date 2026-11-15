import type { Metadata } from "next";
import { TrackView } from "./track-view";

// Guest order tracking (founder rule K). The page itself holds no data: the order is fetched by the browser
// with the token from the link's fragment. No third-party scripts, never indexed or cached, no referrer
// (headers in next.config.ts). Only links the Owner creates exist; there is no public checkout.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function TrackPage() {
  return (
    <main className="mx-auto min-h-screen max-w-xl bg-white px-4 py-8 text-gray-900">
      <TrackView />
    </main>
  );
}
