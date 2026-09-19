/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  serverExternalPackages: ['better-sqlite3'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
