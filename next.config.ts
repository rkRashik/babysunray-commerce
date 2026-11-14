import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // CLAUDE.md is the single source of agent instructions; do not let `next dev` write AGENTS.md.
  agentRules: false,
};

export default nextConfig;
