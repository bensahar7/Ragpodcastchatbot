import type { NextConfig } from "next";

// Embedding moved from a local onnxruntime model to the OpenAI API, so the
// native-addon externals and the outputFileTracingIncludes that shipped
// ~100MB of ONNX binaries with the chat function are no longer needed.
const nextConfig: NextConfig = {};

export default nextConfig;
