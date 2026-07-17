import { describe, expect, test } from "bun:test"
import type { ListObjectsResponse, ListObjectTypesResponse } from "../src/generated/types.gen"
import { toObjectSummary } from "../src/models"

type ObjectListItem = ListObjectsResponse["objects"][number]
type ObjectTypeDefinition = ListObjectTypesResponse[number]

const object: ObjectListItem = {
  primaryId: "quote-1",
  objectTypeId: "Quote",
  properties: { name: "Quote 1" },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
}

const objectType: ObjectTypeDefinition = {
  id: "Quote",
  name: "Quote",
  properties: [],
  links: [],
  actions: [
    {
      id: "updateCategory",
      name: "updateCategory",
      params: [
        {
          id: "category",
          name: "category",
          schema: { type: "enum", valueType: "string", values: ["general_services"] },
          required: false,
          nullable: true,
        },
      ],
    },
  ],
}

describe("client object models", () => {
  test("preserves nullable action parameter metadata", () => {
    const summary = toObjectSummary(object, objectType)

    expect(summary.actions.updateCategory?.params?.category).toMatchObject({
      required: false,
      nullable: true,
    })
  })
})
