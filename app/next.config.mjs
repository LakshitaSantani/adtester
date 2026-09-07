/** @type {import('next').NextConfig} */
const nextConfig = {
  // Both database drivers are loaded at runtime, never bundled.
  //
  // PGlite ships a wasm binary, and `pg` conditionally requires `fs` for TLS
  // certificates — which webpack can't resolve when it traces the module
  // graph from instrumentation.ts. Marking them external means Node requires
  // them itself at run time, which is what we want for both anyway.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],

  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        "pg",
        "pg-native",
        "@electric-sql/pglite",
      ];
    }
    return config;
  },
};

export default nextConfig;
