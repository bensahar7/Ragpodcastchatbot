import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @xenova/transformers loads onnxruntime-node, which is a native addon.
  // Bundling it breaks the .node/.so resolution, so keep it external...
  serverExternalPackages: ["@xenova/transformers", "onnxruntime-node", "sharp"],

  // ...and make sure the native binaries actually ship with the function.
  // Without this the deployed route dies with
  //   libonnxruntime.so.1.14.0: cannot open shared object file
  outputFileTracingIncludes: {
    "/api/chat": [
      "./node_modules/onnxruntime-node/bin/**/*",
      "./node_modules/@xenova/transformers/**/*",
    ],
  },
};

export default nextConfig;
