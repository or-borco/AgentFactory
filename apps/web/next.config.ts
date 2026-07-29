import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agentfactory/shared", "@agentfactory/db"],
};

export default nextConfig;
