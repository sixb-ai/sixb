import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Slider } from "../src/components/ui/slider"

describe("Slider", () => {
  // Reproduce by spreading `aria-label` onto the root again: the root is a plain span, and the
  // thumb, the element with the slider role, goes unnamed.
  test("names the thumb, the element assistive technology reads as the slider", () => {
    const html = renderToStaticMarkup(
      <Slider value={[3]} max={10} aria-label="Playback position" />
    )

    expect(html).toMatch(/<span role="slider"[^>]* aria-label="Playback position"/)
    expect(html.match(/aria-label=/g)).toHaveLength(1)
  })
})
