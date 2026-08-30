"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useUi } from "./AppShell";
import { useWallet } from "@/hooks/useWallet";
import { shortAddress } from "@/lib/format";
import { ACCENTS } from "@/lib/theme";

const NAV = [
  ["Home", "/"],
  ["Batch", "/batch"],
  ["Trade", "/trade"],
  ["Claims", "/claims"],
  ["Explorer", "/explorer"],
  ["Proof", "/proof"],
] as const;

export function Header() {
  const { theme, accent, t, setTheme, setAccent } = useUi();
  const path = usePathname();
  const { address, connect, connecting, hasProvider, wrongChain } = useWallet();

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "12px 26px",
        padding: "14px 24px",
        borderBottom: "1px solid var(--line)",
        background: "var(--bgTint)",
        backdropFilter: "blur(10px)",
      }}
    >
      <Link
        href="/"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          color: "inherit",
        }}
      >
        {/* Two discs meeting — the two sides of a batch colliding at the clearing line. */}
        <div style={{ position: "relative", width: 34, height: 20 }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "var(--acc)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 14,
              top: 0,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "var(--fg)",
              mixBlendMode: "difference",
            }}
          />
        </div>
        <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.03em" }}>
          Walras
        </span>
      </Link>

      <nav style={{ display: "flex", flexWrap: "wrap", gap: 4, minWidth: 0 }}>
        {NAV.map(([label, href]) => {
          const active = path === href;
          return (
            <Link
              key={href}
              href={href}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                fontSize: 15,
                color: active ? t.fg : t.dim,
                background: active ? t.panel2 : "transparent",
              }}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 7,
            alignItems: "center",
            padding: "7px 12px",
            border: "1px solid var(--line)",
            borderRadius: 999,
          }}
        >
          {ACCENTS.map(([name, col]) => (
            <button
              key={name}
              title={name}
              aria-label={`Accent ${name}`}
              onClick={() => setAccent(col)}
              style={{
                width: 15,
                height: 15,
                borderRadius: "50%",
                background: col,
                outline: `1px solid ${col === accent ? t.fg : "transparent"}`,
                outlineOffset: 2,
              }}
            />
          ))}
        </div>

        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="mono"
          style={{
            padding: "8px 14px",
            border: "1px solid var(--line)",
            borderRadius: 8,
            fontSize: 11,
            letterSpacing: "0.06em",
            color: t.dim,
          }}
        >
          {theme === "dark" ? "LIGHT" : "DARK"}
        </button>

        <div
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            border: `1px solid ${wrongChain ? t.fg : "var(--line)"}`,
            borderRadius: 8,
            fontSize: 11.5,
            color: wrongChain ? t.fg : t.dim,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: wrongChain ? t.fg : "var(--acc)",
            }}
          />
          {wrongChain ? "WRONG NETWORK" : "Unichain Sepolia"}
        </div>

        <button
          onClick={address ? undefined : connect}
          disabled={!hasProvider || connecting}
          className="mono"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "7px 13px",
            border: "1px solid var(--line)",
            borderRadius: 8,
            fontSize: 11.5,
            color: t.fg,
            cursor: address ? "default" : "pointer",
          }}
        >
          <span
            style={{
              width: 15,
              height: 15,
              borderRadius: 4,
              background: address ? "var(--acc)" : t.line,
            }}
          />
          {!hasProvider
            ? "NO WALLET"
            : connecting
              ? "CONNECTING…"
              : address
                ? shortAddress(address)
                : "CONNECT"}
        </button>
      </div>
    </header>
  );
}
