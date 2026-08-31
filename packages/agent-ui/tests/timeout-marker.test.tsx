import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RunTimeoutMarker } from "../src/components/MessageView"

describe("RunTimeoutMarker", () => {
  test("offers continuation when coherent progress was retained", () => {
    const html = renderToStaticMarkup(
      <RunTimeoutMarker hasProgress timeoutMs={600_000} onContinue={() => {}} />
    )

    expect(html).toContain("Stopped after reaching the 10-minute turn limit.")
    expect(html).toContain("Continue")
    expect(html).not.toContain("Try again")
  })

  test("offers retry when the timeout produced no coherent progress", () => {
    const html = renderToStaticMarkup(
      <RunTimeoutMarker hasProgress={false} timeoutMs={30_000} onRetry={() => {}} />
    )

    expect(html).toContain(
      "The response reached the 30-second turn limit before producing an answer."
    )
    expect(html).toContain("Try again")
    expect(html).not.toContain(">Continue<")
  })
})
