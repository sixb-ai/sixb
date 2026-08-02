import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RunFailure, type RunFailureRecord } from "../src/components/common"

/**
 * A recorded failure is only worth recording if a reader can see all of it. Ten places used to
 * render one of these and every one of them showed the message alone, so a code nobody could read
 * and a `cause` nobody could read were the same as not storing them.
 *
 * To see the teeth — each was run and watched to fail before this landed: drop the `cause` line from
 * the block variant (fails "shows everything the record carries"), drop `details` from the tooltip
 * join (fails "keeps what it truncates in the tooltip"), or render the code through a lookup table
 * instead of as itself (fails "renders a code it does not know").
 */

const failure: RunFailureRecord = {
  code: "storage.unavailable",
  message: "could not reach the object store",
  details: { provider: "@sixb/pg", attempt: 3 },
  cause: "connect: ECONNREFUSED 127.0.0.1:5432",
  phase: "effects",
}

describe("RunFailure", () => {
  test("shows everything the record carries", () => {
    const html = renderToStaticMarkup(<RunFailure failure={failure} />)

    expect(html).toContain("storage.unavailable")
    expect(html).toContain("could not reach the object store")
    expect(html).toContain("connect: ECONNREFUSED 127.0.0.1:5432")
    expect(html).toContain("provider")
    expect(html).toContain("@sixb/pg")
    expect(html).toContain("attempt")
    expect(html).toContain("3")
    expect(html).toContain("effects")
  })

  test("omits what the record does not carry", () => {
    const html = renderToStaticMarkup(
      <RunFailure failure={{ code: "sync.failed", message: "the source refused the read" }} />
    )

    expect(html).toContain("sync.failed")
    expect(html).toContain("the source refused the read")
    // No empty phase chip and no empty details list where a run recorded neither.
    expect(html).not.toContain("<dl")
    expect(html).not.toContain("<span")
  })

  test("keeps what it truncates in the tooltip", () => {
    const html = renderToStaticMarkup(<RunFailure failure={failure} variant="inline" />)

    // The line itself is the message; a row in a list has no room for the rest.
    expect(html).toContain(">could not reach the object store<")
    for (const hidden of [
      "storage.unavailable",
      "connect: ECONNREFUSED 127.0.0.1:5432",
      "provider: @sixb/pg",
      "attempt: 3",
    ]) {
      expect(html).toContain(hidden)
    }
  })

  test("renders a code it does not know", () => {
    // The enum is closed and a minor bump may add to it, so an Atlas older than a code has to show
    // the raw string rather than blank the failure.
    const html = renderToStaticMarkup(
      <RunFailure failure={{ code: "quota.exhausted", message: "out of room" }} />
    )

    expect(html).toContain("quota.exhausted")
    expect(html).toContain("out of room")
  })
})
