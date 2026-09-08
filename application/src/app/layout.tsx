import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "10-K Metric Extractor",
  description:
    "Scans 10-K PDFs, extracts three tax and equity metrics, and grades itself against a ground-truth table.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
