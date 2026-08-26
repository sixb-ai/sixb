import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StructuredValue } from "../src/components/StructuredValue"

describe("StructuredValue debug presentation", () => {
  test("keeps short strings and object identifiers readable instead of truncating them", () => {
    const title = "AHU-3 outside-air damper failed to track commanded position"
    const primaryId = "equipment=broad-ahu-3/with/a/long/debug-identifier"
    const markup = renderToStaticMarkup(
      <StructuredValue
        variant="debug"
        value={{
          equipment: { objectTypeId: "Equipment", primaryId },
          title,
        }}
      />
    )

    expect(markup).toContain(title)
    expect(markup).toContain(primaryId)
    expect(markup).toContain("break-all")
    expect(markup).not.toContain("truncate")
    expect(markup).not.toContain("bg-muted/60")
  })

  test("preserves the compact chip presentation outside debugging surfaces", () => {
    const markup = renderToStaticMarkup(<StructuredValue value={{ title: "A compact value" }} />)

    expect(markup).toContain("truncate")
    expect(markup).toContain("bg-muted/60")
  })
})
