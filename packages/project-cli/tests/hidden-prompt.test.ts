import { describe, expect, test } from "bun:test"
import { type HiddenInput, readHiddenKeys } from "../src/lib/hidden-prompt"

const START = "\u001b[200~"
const END = "\u001b[201~"

const type = (...chunks: readonly string[]): HiddenInput =>
  chunks.reduce(readHiddenKeys, { value: "", pending: "" })

describe("readHiddenKeys", () => {
  test("keeps what's typed, and Enter finishes", () => {
    expect(type("abc", "\r")).toEqual({ value: "abc", pending: "", outcome: "done" })
  })

  test("backspace removes a whole character", () => {
    expect(type("a😀", "\u007f").value).toBe("a")
  })

  test("Ctrl-C cancels", () => {
    expect(type("abc\u0003").outcome).toBe("cancelled")
  })

  test("arrow keys aren't part of the value", () => {
    expect(type("a\u001b[Ab").value).toBe("ab")
  })

  // Reproduce: treat every newline as Enter. Pasting a key then stores its first line, and "Set"
  // still prints, so it only fails when the app uses the key.
  test("a marked paste keeps its lines, and waits for Enter", () => {
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----"

    const pasted = type(`${START}${pem}\n${END}`)
    expect(pasted).toEqual({ value: pem, pending: "" })
    expect(readHiddenKeys(pasted, "\r").outcome).toBe("done")
  })

  test("a paste arriving in pieces stays whole", () => {
    expect(type(`${START}line1\nli`, `ne2${END}`).value).toBe("line1\nline2")
  })

  test("carriage returns in a paste become newlines", () => {
    expect(type(`${START}a\r\nb${END}`).value).toBe("a\nb")
  })

  test("an unmarked paste with several lines is refused, not cut short", () => {
    expect(type("line1\nline2\n").outcome).toBe("refused")
  })

  test("an unmarked paste ending in a newline is one line", () => {
    expect(type("value\n")).toEqual({ value: "value", pending: "", outcome: "done" })
  })
})
