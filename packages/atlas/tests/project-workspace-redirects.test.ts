import { describe, expect, test } from "bun:test"
import type { Location } from "react-router-dom"
import { objectInApp, objectsInApp, ontologyInApp } from "../src/pages/ProjectWorkspace"

const at = (path: string): Location => {
  const url = new URL(path, "https://atlas.sixb.test")
  return { pathname: url.pathname, search: url.search, hash: "", state: null, key: "default" }
}

describe("old Atlas links follow their page into the app", () => {
  test.each([
    ["/objects", "/ontology/objects"],
    ["/objects?class=Deal", "/ontology/objects?type=Deal"],
    ["/objects?class=Work%20Order", "/ontology/objects?type=Work%20Order"],
  ])("objects %s", (from, to) => {
    expect(objectsInApp(at(from))).toBe(to)
  })

  // Regression proof: drop the `tab` lines in ontologyInApp and the last case lands on Properties.
  test.each([
    ["/ontology", "/ontology/graph"],
    ["/ontology?type=Deal", "/ontology/graph?type=Deal"],
    ["/ontology?type=Deal&view=details", "/ontology/object-types/Deal"],
    ["/ontology?type=Deal&view=details&tab=links", "/ontology/object-types/Deal?tab=links"],
  ])("ontology %s", (from, to) => {
    expect(ontologyInApp(at(from))).toBe(to)
  })

  // Regression proof: drop the try/catch in objectInApp and the malformed escape throws a URIError.
  test.each([
    ["/Deal~D-48231", "/objects/Deal/D-48231"],
    ["/Work%2520Order~WO%252F7", "/objects/Work%20Order/WO%2F7"],
    ["/no-separator", "/ontology/objects"],
    ["/%E0%A4%A", "/ontology/objects"],
  ])("object %s", (from, to) => {
    expect(objectInApp(at(from))).toBe(to)
  })
})
