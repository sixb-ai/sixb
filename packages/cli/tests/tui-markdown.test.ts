import { describe, expect, test } from "bun:test"
import { steadyMarkdown } from "../src/tui/markdown"

describe("an answer still being written", () => {
  test("closes the emphasis and code its last line opened", () => {
    expect(steadyMarkdown("Here is a **sum")).toBe("Here is a **sum**")
    expect(steadyMarkdown("A **summary** of `inline c")).toBe("A **summary** of `inline c`")
    expect(steadyMarkdown("**bold *nested")).toBe("**bold *nested***")
    expect(steadyMarkdown("~~struck")).toBe("~~struck~~")
    expect(steadyMarkdown("A word **then ")).toBe("A word **then**")
  })

  test("drops an opener with nothing after it yet", () => {
    expect(steadyMarkdown("A word **")).toBe("A word")
    expect(steadyMarkdown("A word *")).toBe("A word")
  })

  test("leaves what is not emphasis alone", () => {
    for (const text of [
      "snake_case_name and 2 * 3 = 6",
      "Use `a * b` and `c ** d`",
      "An escaped \\*star",
      "* a bullet",
    ]) {
      expect(steadyMarkdown(text)).toBe(text)
    }
  })

  test("holds a link back until its label is complete, then shows the label alone", () => {
    expect(steadyMarkdown("See [the do")).toBe("See")
    expect(steadyMarkdown("See [the docs]")).toBe("See")
    expect(steadyMarkdown("See [the docs](https://sixb.ai/d")).toBe("See the docs")
    expect(steadyMarkdown("See [the docs](https://sixb.ai/d) and")).toBe(
      "See [the docs](https://sixb.ai/d) and"
    )
    expect(steadyMarkdown("Index `a[0` here")).toBe("Index `a[0` here")
  })

  test("holds back a line that is only a block's marker", () => {
    for (const marker of ["#", "##", "-", "*", "2", "2.", ">", "``", "--"]) {
      expect(steadyMarkdown(`A paragraph.\n\n${marker}`)).toBe("A paragraph.")
    }
  })

  test("holds back a table or a quote until a blank line ends it", () => {
    const table = "| Thread | When |\n| --- | --- |\n| Acme | 09:12 |"
    expect(steadyMarkdown(`Today:\n\n${table}`)).toBe("Today:")
    expect(steadyMarkdown(`Today:\n\n${table}\n`)).toBe("Today:")
    expect(steadyMarkdown(`Today:\n\n${table}\n\nThat`)).toBe(`Today:\n\n${table}\n\nThat`)
    expect(steadyMarkdown("Today:\n\n> **Note**: read it")).toBe("Today:")
  })

  test("draws the code of an open fence as it arrives", () => {
    expect(steadyMarkdown("```ts\nconst b = **x")).toBe("```ts\nconst b = **x")
    expect(steadyMarkdown("```ts\nconst b = 1\n``")).toBe("```ts\nconst b = 1")
    expect(steadyMarkdown("```ts\nx\n```\n\nNow **bo")).toBe("```ts\nx\n```\n\nNow **bo**")
  })
})
