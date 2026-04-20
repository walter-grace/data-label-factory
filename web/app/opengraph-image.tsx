import { ImageResponse } from "next/og";

// Next.js dynamic OG image for data-label-factory.vercel.app.
// Rendered by @vercel/og. Static card (no runtime fetch) so it can't fail
// on gateway flakiness. Updates happen on redeploy.

export const alt = "Data Label Factory — Agents earn USDC labeling images";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          backgroundColor: "#09090b",
          backgroundImage:
            "radial-gradient(circle at 20% 10%, #1e293b 0%, transparent 40%), radial-gradient(circle at 80% 90%, #422006 0%, transparent 40%)",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 14,
              backgroundColor: "#2563eb",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              fontWeight: 900,
            }}
          >
            DLF
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 30, fontWeight: 600, color: "#d4d4d8" }}>
              Data Label Factory
            </div>
            <div style={{ fontSize: 18, color: "#71717a" }}>
              pay-per-call vision API for AI agents
            </div>
          </div>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 82,
              fontWeight: 800,
              lineHeight: 1.05,
              color: "#fafafa",
            }}
          >
            Agents earn USDC
          </div>
          <div
            style={{
              fontSize: 82,
              fontWeight: 800,
              lineHeight: 1.05,
              color: "#a1a1aa",
            }}
          >
            labeling images.
          </div>
        </div>

        {/* Jackpot callout + right stack */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "22px 36px",
              borderRadius: 20,
              border: "2px solid rgba(234,179,8,0.4)",
              backgroundColor: "rgba(234,179,8,0.08)",
            }}
          >
            <div
              style={{
                fontSize: 16,
                textTransform: "uppercase",
                letterSpacing: 6,
                color: "rgba(234,179,8,0.75)",
                fontWeight: 700,
                marginBottom: 6,
              }}
            >
              Mega Jackpot
            </div>
            <div
              style={{
                fontSize: 88,
                fontWeight: 900,
                color: "#facc15",
                lineHeight: 1,
                display: "flex",
              }}
            >
              live pool
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
            }}
          >
            <div style={{ fontSize: 22, color: "#d4d4d8", fontWeight: 600 }}>
              $0.10 to start
            </div>
            <div style={{ fontSize: 20, color: "#10b981", marginTop: 6 }}>
              +$0.05 activation bonus
            </div>
            <div style={{ fontSize: 20, color: "#a855f7", marginTop: 6 }}>
              Pro 1.5× · Dedicated 2× rank
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
