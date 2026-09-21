import { describe, expect, test } from "bun:test"
import { isMultiTypeLink, ontologyGraphLinkTargets } from "../src/lib/ontologyGraphLinks"

const typeIds = new Set(["suggestion", "account", "transaction", "document"])

describe("ontology graph multi-type links", () => {
  // Regression check: remove the isMultiTypeLink/selectedTypeId filter in
  // ontologyGraphLinkTargets. The overview and selection tests must fail.
  test("keeps open relationships from fanning out across the overview", () => {
    for (const target of ["*", [...typeIds]]) {
      expect(isMultiTypeLink(target)).toBe(true)
      expect(ontologyGraphLinkTargets(target, typeIds, null)).toEqual([])
    }
  })

  test("shows only the selected target, including self-links", () => {
    for (const target of ["*", [...typeIds]]) {
      expect(ontologyGraphLinkTargets(target, typeIds, "account")).toEqual(["account"])
      expect(ontologyGraphLinkTargets(target, typeIds, "suggestion")).toEqual(["suggestion"])
      expect(ontologyGraphLinkTargets(target, typeIds, "hidden")).toEqual([])
    }
    expect(ontologyGraphLinkTargets(["account", "document"], typeIds, "transaction")).toEqual([])
  })

  test("preserves concrete links regardless of selection and excludes missing types", () => {
    for (const selection of [null, "account", "document"]) {
      expect(ontologyGraphLinkTargets("transaction", typeIds, selection)).toEqual(["transaction"])
      expect(ontologyGraphLinkTargets(["account"], typeIds, selection)).toEqual(["account"])
      expect(ontologyGraphLinkTargets("missing", typeIds, selection)).toEqual([])
    }
    expect(isMultiTypeLink(["account", "account"])).toBe(false)
    expect(ontologyGraphLinkTargets(["account", "account"], typeIds, null)).toEqual(["account"])
    expect(ontologyGraphLinkTargets([], typeIds, null)).toEqual([])
  })
})
