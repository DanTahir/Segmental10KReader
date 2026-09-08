/** @type {import('next').NextConfig} */
const nextConfig = {
  // The extractor shells out to pdftotext and reads the PDFs from disk, so the
  // API routes must run on the Node runtime (not edge).
  serverExternalPackages: [],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
