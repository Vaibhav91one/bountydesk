import type { NextConfig } from "next";

function assertTrueForgeConfiguration() {
  const rawUrl = process.env.TRUEFORGE_URL;
  if (!rawUrl) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("TRUEFORGE_URL must be a valid absolute URL");
  }

  const hostname = url.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);

  if (!isLoopback && !process.env.TRUEFORGE_API_KEY?.trim()) {
    throw new Error(
      "Refusing to start: non-loopback TRUEFORGE_URL requires TRUEFORGE_API_KEY",
    );
  }
}

assertTrueForgeConfiguration();

const nextConfig: NextConfig = {
  // Integrations and Connections used to live under /settings. They are what a person sets up
  // on their first day rather than something they go looking for in settings, so they moved
  // out; anyone holding an old link still lands on the right screen.
  async redirects() {
    return [
      { source: "/settings/integrations", destination: "/integrations", permanent: false },
      { source: "/settings/connections", destination: "/connections", permanent: false },
    ];
  },
  /* config options here */
};

export default nextConfig;
