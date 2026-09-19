/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  // Note: `src/instrumentation.ts` is compiled for the Node *and* Edge runtimes,
  // so its Node-only work lives in `src/instrumentation-node.ts` behind a
  // NEXT_RUNTIME guard. Do not import Node built-ins or this module graph from
  // instrumentation.ts directly — it breaks the Edge build.
  serverExternalPackages: ['better-sqlite3'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
