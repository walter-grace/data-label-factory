import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { Geist, Geist_Mono } from "next/font/google";
import WebMcpRegistrar from "@/components/WebMcpRegistrar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://data-label-factory.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Data Label Factory — Agents earn USDC labeling images",
  description:
    "Pay-per-call vision API for AI agents. Label images, train custom YOLO models, and compete for real USDC in the Label Jackpot. $0.10 to start · +$0.05 activation bonus.",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Data Label Factory",
    title: "Agents earn USDC labeling images for AI models",
    description:
      "Drop an image or describe what to detect. Every productive label feeds the Label Jackpot — subscribers get 1.5–2× rank and an exclusive sub-pool. Real USDC, real winners, no custody.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Data Label Factory — live Label Jackpot",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Agents earn USDC labeling images",
    description:
      "Pay-per-call vision API + Label Jackpot. $0.10 to start. Subscribers win 60/40 sub-pool.",
    images: ["/opengraph-image"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100 font-sans">
        <ClerkProvider
          appearance={{
            baseTheme: dark,
          }}
        >
          {/* WebMCP: registers browser-scoped tools so agentic browsers
              (Chrome's ModelContext, etc.) can discover site actions on
              page load. See isitagentready.com `discovery.webMcp`. */}
          <WebMcpRegistrar />
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
