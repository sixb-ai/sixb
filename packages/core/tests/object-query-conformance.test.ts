import { expect, test } from "bun:test"
import { collectObjectQueryValidationIssues } from "../src/objects/query"
import { InMemoryStorage } from "../src/storage"
import { objectQueryContractOntology, runObjectQueryProviderContractSuite } from "../src/testing"

runObjectQueryProviderContractSuite("InMemoryStorage object query provider contract", {
  createStorage: () => new InMemoryStorage(),
})

// Validation reads no provider: it runs once, here.
test("collects validation failures before provider planning", () => {
  const issues = collectObjectQueryValidationIssues(
    {
      kind: "filter",
      predicate: { op: "eq", propertyId: "missing", value: "x" },
      input: {
        kind: "text",
        query: "alpha",
        fields: ["capacity"],
        input: { kind: "start", objectTypeId: "ContractRoom" },
      },
    },
    { ontology: objectQueryContractOntology }
  )

  expect(issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining([
      "unknown_property",
      "query_field_not_enabled",
      "text_field_not_string_like",
    ])
  )
})
