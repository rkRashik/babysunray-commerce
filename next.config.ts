import type { NextConfig } from "next";

// Set only by the browser tests (tests/e2e/global-setup.ts). Their `next dev` runs beside a developer's own,
// and Next.js allows one dev server per output directory; it may also rewrite the tsconfig it is given, so
// it gets a generated, git-ignored tsconfig.e2e.json instead of the committed tsconfig.json.
const e2eDistDir = process.env.E2E_NEXT_DIST_DIR;

// The guest tracking page and its endpoints (founder rule K, S-15): never cached or indexed, no referrer, and a
// content security policy that allows only this origin, so no third-party script, frame or request can see the
// page. Next.js needs inline scripts; development also needs eval for its tooling.
const TRACKING_HEADERS = [
  { key: "Cache-Control", value: "no-store" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

// The Owner Office: never framed by another site (clickjacking of its buttons), never indexed, no MIME sniffing,
// and no full URL (which can carry order or count ids) sent to another origin. Pages are dynamic, so Next.js
// already marks them no-store.
const OFFICE_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

// The shop (/en, /bn; ADR-0011): never framed, and not indexed while it is open only for founder acceptance (revisit
// X-Robots-Tag in the change that opens the public launch gate). Pages read cookies, so Next.js marks them no-store.
const SHOP_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // CLAUDE.md is the single source of agent instructions; do not let `next dev` write AGENTS.md.
  agentRules: false,
  async headers() {
    return [
      { source: "/track", headers: TRACKING_HEADERS },
      { source: "/api/track/:path*", headers: TRACKING_HEADERS },
      { source: "/api/track", headers: TRACKING_HEADERS },
      { source: "/office", headers: OFFICE_HEADERS },
      { source: "/office/:path*", headers: OFFICE_HEADERS },
      ...["/en", "/en/:path*", "/bn", "/bn/:path*", "/api/shop/:path*", "/api/customer-auth/:path*"].map((source) => ({ source, headers: SHOP_HEADERS })),
    ];
  },
  // The development tools button is left out there so pages behave (and tab) as they would in production.
  ...(e2eDistDir ? { distDir: e2eDistDir, typescript: { tsconfigPath: "tsconfig.e2e.json" }, devIndicators: false } : {}),
};

export default nextConfig;
