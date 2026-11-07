import { describe, expect, test } from "bun:test"
import { isRootPath, normalizePath, parentPath, sectionOf } from "../src/shell/phone/routes"

describe("where a screen sits in a phone's navigation", () => {
  test("a single segment is a top-level screen; anything deeper is pushed on it", () => {
    expect(isRootPath("/")).toBe(true)
    expect(isRootPath("/service-cases")).toBe(true)
    expect(isRootPath("/service-cases/")).toBe(true)
    expect(isRootPath("/service-cases/sc-1038")).toBe(false)
  })

  test("a screen's section is its first segment, and Home's is empty", () => {
    expect(sectionOf("/")).toBe("")
    expect(sectionOf("/threads")).toBe("threads")
    expect(sectionOf("/threads/t-1")).toBe("threads")
  })

  test("Back without history climbs one segment", () => {
    expect(parentPath("/service-cases/sc-1038")).toBe("/service-cases")
    expect(parentPath("/invoices/i-1/edit")).toBe("/invoices/i-1")
    expect(parentPath("/service-cases")).toBe("/")
    expect(normalizePath("/quotes///")).toBe("/quotes")
  })
})
