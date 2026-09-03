import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Next writes AGENTS.md and CLAUDE.md into this directory on every dev run. They
  // describe Next itself rather than this project, so they are noise in the repo.
  agentRules: false,
};

export default nextConfig;
