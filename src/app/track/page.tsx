import type { Metadata, Viewport } from "next";
import { BrandLogo } from "@/app/_design/brand";
import { flFontVariables } from "@/app/_design/fonts";
import { installationIdentity } from "@/config/installation";
import { TrackView } from "./track-view";

// Guest order tracking (founder rule K). The page itself holds no data: the order is fetched by the browser
// with the token from the link's fragment. No third-party scripts, never indexed or cached, no referrer
// (headers in next.config.ts). Only links the Owner creates exist; there is no public checkout. It wears the
// First Light storefront design with the installation's own name, logo and colours; fonts and logo are served from this
// origin, nothing is loaded from elsewhere.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false }, referrer: "no-referrer" };

export const viewport: Viewport = { viewportFit: "cover", themeColor: "#f9f6f1" };

export default function TrackPage() {
  const identity = installationIdentity();
  const theme = { "--color-sf-ink": identity.theme.ink, "--color-sf-sun": identity.theme.accent, "--color-sf-paper": identity.theme.paper } as React.CSSProperties;
  return <TrackView logo={<BrandLogo name={identity.storeName} height={34} textClassName="text-[1.5rem]" />} className={`sf ${flFontVariables} min-h-dvh`} style={theme} />;
}
