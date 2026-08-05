/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module — keep it out of the client/edge bundle,
  // exactly as FounderOS does. It only ever runs in server components / route
  // handlers reading the shared sssf.db.
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
  },
};

export default nextConfig;
