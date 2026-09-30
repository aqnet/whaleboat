import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Cloud Run image (web/Dockerfile).
  output: "standalone",
  // Lets the Mac host open the dev server running in the VMware VM
  // (http://172.16.63.131:3000). The VM's display adapter has no WebGL2,
  // which MapLibre and deck.gl require, so the map has to be viewed from the host.
  allowedDevOrigins: ["172.16.63.131"],
};

export default nextConfig;
