import type { NextConfig } from "next";

// Set only by the browser tests (tests/e2e/global-setup.ts). Their `next dev` runs beside a developer's own,
// and Next.js allows one dev server per output directory; it may also rewrite the tsconfig it is given, so
// it gets a generated, git-ignored tsconfig.e2e.json instead of the committed tsconfig.json.
const e2eDistDir = process.env.E2E_NEXT_DIST_DIR;

const nextConfig: NextConfig = {
  // CLAUDE.md is the single source of agent instructions; do not let `next dev` write AGENTS.md.
  agentRules: false,
  // The development tools button is left out there so pages behave (and tab) as they would in production.
  ...(e2eDistDir ? { distDir: e2eDistDir, typescript: { tsconfigPath: "tsconfig.e2e.json" }, devIndicators: false } : {}),
};

export default nextConfig;
