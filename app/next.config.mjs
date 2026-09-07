/** @type {import('next').NextConfig} */
const nextConfig = {
  // PGlite ships a wasm binary; keep it external so Next doesn't try to bundle it.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default nextConfig;
