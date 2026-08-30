import type { Metadata } from "next";
import { Archivo, Azeret_Mono } from "next/font/google";

import { AppShell } from "@/components/AppShell";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-archivo",
  display: "swap",
});

const azeret = Azeret_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-azeret",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Walras",
  description:
    "Sealed batch auctions on Uniswap v4. Every order in a window settles at one uniform clearing price, and direct swaps through the pool revert.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${archivo.variable} ${azeret.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
