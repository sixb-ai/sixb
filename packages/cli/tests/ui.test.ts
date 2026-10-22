import { afterEach, describe, expect, test } from "bun:test"
import { rows, wrap } from "../src/ui/layout"
import { colorLevel, paint, palette } from "../src/ui/theme"

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe("terminal color", () => {
  test("follows NO_COLOR, then FORCE_COLOR, then whether the stream is a terminal", () => {
    delete process.env.NO_COLOR
    delete process.env.FORCE_COLOR
    expect(colorLevel({ isTTY: false })).toBe(0)
    expect(colorLevel({ isTTY: true })).toBeGreaterThan(0)

    process.env.FORCE_COLOR = "3"
    expect(colorLevel({ isTTY: false })).toBe(3)

    process.env.NO_COLOR = "1"
    expect(colorLevel({ isTTY: true })).toBe(0)
  })

  test("paints only where color is on, in the depth the terminal takes", () => {
    expect(paint("ready", { color: palette.blue }, 0)).toBe("ready")
    expect(paint("ready", { color: palette.blue }, 3)).toBe("\x1b[38;2;10;132;255mready\x1b[0m")
    expect(paint("ready", { color: palette.blue }, 2)).toBe("\x1b[38;5;39mready\x1b[0m")
    expect(paint("ready", { color: palette.blue }, 1)).toBe("\x1b[34mready\x1b[0m")
  })
})

describe("layout", () => {
  test("wraps at spaces, and breaks a word longer than the line", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"])
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
  })

  test("lines values up after their labels", () => {
    process.env.NO_COLOR = "1"
    expect(
      rows([
        { label: "app", value: "http://localhost:3000" },
        { label: "workers", value: "agent 8" },
      ])
    ).toBe("app      http://localhost:3000\nworkers  agent 8")
  })
})
