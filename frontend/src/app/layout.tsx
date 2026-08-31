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
    "A Uniswap v4 pool that collects orders for 12 seconds and trades them all at one price, so bots cannot jump ahead of you.",
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
