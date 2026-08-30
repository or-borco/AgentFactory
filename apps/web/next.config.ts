import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@agentfactory/core",
    "@agentfactory/shared",
    "@agentfactory/db",
    "@agentfactory/queue",
    "@agentfactory/storage",
  ],
};

export default nextConfig;
