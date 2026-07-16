import type React from "react";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Allyra.ai",
  description: "Allyra.ai is an AI automation workspace for browser and desktop tasks.",
  icons: {
    icon: "/Allyra_icon.png",
    shortcut: "/Allyra_icon.png",
    apple: "/Allyra_icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>{children}</body>
    </html>
  );
}
