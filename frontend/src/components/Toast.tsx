"use client";

export function Toast({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mono"
      style={{
        position: "fixed",
        bottom: 26,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 40,
        background: "var(--acc)",
        color: "var(--onAcc)",
        padding: "13px 22px",
        borderRadius: 10,
        fontSize: 12,
        maxWidth: "calc(100vw - 32px)",
        textAlign: "center",
        animation: "rowIn 0.25s ease both",
      }}
    >
      {message}
    </div>
  );
}
