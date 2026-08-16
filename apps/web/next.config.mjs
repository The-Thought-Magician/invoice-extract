/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@invoice-extract/core", "@invoice-extract/adapters"],
  // pg and PGlite must not be bundled: they load native or wasm assets at runtime.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  experimental: { serverActions: { bodySizeLimit: "25mb" } },
};
