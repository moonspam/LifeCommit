import type { Metadata, Viewport } from "next";
import { Fira_Code } from "next/font/google";
import "./globals.css";

// Bundled at build time (no runtime request to Google Fonts)
const firaCode = Fira_Code({ subsets: ["latin"], weight: ["300", "400", "500", "600"], display: "swap", variable: "--font-fira" });

export const metadata: Metadata = {
  title: "LifeCommit",
  description: "Local-first life logging app with Git-style commit history",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0d1117",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={firaCode.variable}>
      <body className="font-mono antialiased bg-terminal-bg text-terminal-white">
        {children}
      </body>
    </html>
  );
}
