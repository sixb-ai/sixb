import { ImageResponse } from "next/og"

export const alt = "Sixb Docs — Build operational software, end to end"
export const size = {
  width: 1200,
  height: 630,
}
export const contentType = "image/png"

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "stretch",
        background: "#f7f7f5",
        color: "#0a0a0a",
        display: "flex",
        flexDirection: "column",
        fontFamily: "sans-serif",
        height: "100%",
        justifyContent: "space-between",
        padding: "72px 80px",
        position: "relative",
        width: "100%",
      }}
    >
      <div
        style={{
          background: "#2463eb",
          height: 8,
          left: 0,
          position: "absolute",
          top: 0,
          width: "100%",
        }}
      />

      <div style={{ alignItems: "center", display: "flex", gap: 18 }}>
        <svg aria-hidden="true" fill="currentColor" height="42" viewBox="0 0 1080 1080" width="42">
          <path d="M15.94,471.64l67.46,455.36,599.79-189.73,380.88-355.72L368.99,153C243.22,266.91,122.33,375.93,15.94,471.64Z" />
        </svg>
        <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.03em" }}>Sixb</span>
        <span style={{ color: "#aaa9a5", fontSize: 34, fontWeight: 300 }}>/</span>
        <span style={{ fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>Docs</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 930 }}>
        <div
          style={{
            fontSize: 72,
            fontWeight: 700,
            letterSpacing: "-0.045em",
            lineHeight: 1.05,
          }}
        >
          Build operational software, end to end
        </div>
        <div style={{ color: "#62615d", fontSize: 28, lineHeight: 1.4 }}>
          One typed ontology powers your data, APIs, automations, and apps.
        </div>
      </div>

      <div
        style={{
          alignItems: "center",
          borderTop: "1px solid #deddd8",
          color: "#62615d",
          display: "flex",
          fontSize: 22,
          justifyContent: "space-between",
          paddingTop: 26,
        }}
      >
        <span>TypeScript framework for operational software</span>
        <span style={{ color: "#2463eb", fontWeight: 600 }}>docs.sixb.ai</span>
      </div>
    </div>,
    size
  )
}
