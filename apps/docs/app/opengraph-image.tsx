import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ImageResponse } from "next/og"

export const alt = "Sixb Docs — Model your domain. Put it to work. Connect, Prepare, Model, Build."
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const layers = [
  { name: "Build", detail: "Apps, agents, workflows", y: 42 },
  { name: "Model", detail: "Objects, relationships, actions", y: 151 },
  { name: "Prepare", detail: "Data, ready to use", y: 245 },
  { name: "Connect", detail: "Your existing systems", y: 334 },
]

export default async function OpenGraphImage() {
  const artwork = await readFile(join(process.cwd(), "assets/social-stack.svg"))
  const stackImage = `data:image/svg+xml;base64,${artwork.toString("base64")}`
  return new ImageResponse(
    <div
      style={{
        background: "#ffffff",
        color: "#151719",
        display: "flex",
        flexDirection: "column",
        fontFamily: "sans-serif",
        height: "100%",
        padding: "48px 60px 36px",
        width: "100%",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 16 }}>
        <svg aria-hidden="true" fill="currentColor" height="36" viewBox="0 0 1080 1080" width="36">
          <path d="M15.94,471.64l67.46,455.36,599.79-189.73,380.88-355.72L368.99,153C243.22,266.91,122.33,375.93,15.94,471.64Z" />
        </svg>
        <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em" }}>Sixb</span>
        <span style={{ color: "#cbd2da", fontSize: 28 }}>/</span>
        <span style={{ color: "#667384", fontSize: 26 }}>Docs</span>
      </div>

      <div style={{ alignItems: "center", display: "flex", flex: 1, gap: 30 }}>
        <div style={{ display: "flex", flexDirection: "column", width: 590 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 64,
              fontWeight: 700,
              letterSpacing: "-0.055em",
              lineHeight: 1.08,
            }}
          >
            <span>Model your domain.</span>
            <span>Put it to work.</span>
          </div>
          <div
            style={{
              color: "#667384",
              display: "flex",
              flexDirection: "column",
              fontSize: 27,
              lineHeight: 1.45,
              marginTop: 26,
            }}
          >
            <span>A TypeScript framework for</span>
            <span style={{ color: "#151719" }}>ontology-powered apps and AI.</span>
          </div>
        </div>

        <div style={{ display: "flex", height: 430, position: "relative", width: 460 }}>
          {/* biome-ignore lint/performance/noImgElement: ImageResponse requires a native image. */}
          <img
            alt=""
            src={stackImage}
            width={282}
            height={446}
            style={{ left: 0, position: "absolute", top: -8 }}
          />
          {layers.map((layer) => (
            <div
              key={layer.name}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 7,
                left: 287,
                position: "absolute",
                top: layer.y,
                width: 173,
              }}
            >
              <span style={{ fontSize: 23, fontWeight: 700 }}>{layer.name}</span>
              <span style={{ color: "#667384", fontSize: 16, lineHeight: 1.3 }}>
                {layer.detail}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          alignItems: "center",
          borderTop: "1px solid #e4e9ef",
          color: "#667384",
          display: "flex",
          fontSize: 19,
          justifyContent: "space-between",
          paddingTop: 22,
        }}
      >
        <span>Connect. Prepare. Model. Build.</span>
        <span style={{ color: "#006be6", fontWeight: 600 }}>docs.sixb.ai</span>
      </div>
    </div>,
    size
  )
}
