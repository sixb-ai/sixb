import { afterEach, describe, expect, test } from "bun:test"
import { client } from "../src/generated/client.gen"
import type { ListObjectsResponse, ListObjectTypesResponse } from "../src/generated/types.gen"
import { executeAction, executeGlobalAction, toObjectSummary } from "../src/models"

type ObjectListItem = ListObjectsResponse["objects"][number]
type ObjectTypeDefinition = ListObjectTypesResponse[number]

afterEach(() => {
  client.setConfig({
    auth: undefined,
    baseUrl: undefined,
    credentials: undefined,
    fetch: undefined,
  })
})

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
        {
          id: "amount",
          name: "amount",
          schema: "decimal",
          required: true,
          nullable: false,
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
    expect(summary.actions.updateCategory?.params?.amount).toMatchObject({
      type: "string",
      required: true,
    })
  })
})

function configureActionClient(handler: (request: Request) => Response | Promise<Response>): void {
  const fetchMock = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request && !init ? input : new Request(input, init)
      return handler(request)
    },
    { preconnect: fetch.preconnect }
  ) satisfies typeof fetch

  // The documented singleton setup path must still install the package's structured error mapper.
  client.setConfig({
    baseUrl: "http://sixb.test",
    fetch: fetchMock,
  })
}

describe("client action models", () => {
  test("returns a local validation error as a structured value", async () => {
    const result = await executeAction({
      path: { objectId: "invalid", actionId: "approve" },
      body: {},
    })

    expect(result).toEqual({
      data: {
        success: false,
        error: { message: "[SixbClient] Invalid object id 'invalid'." },
      },
    })
  })

  test("preserves the code and status of an API error", async () => {
    configureActionClient(() =>
      Response.json(
        { error: "Action request rejected", code: "internal.unexpected" },
        { status: 500 }
      )
    )

    const result = await executeGlobalAction({
      path: { actionId: "approve" },
      body: {},
    })

    expect(result).toEqual({
      data: {
        success: false,
        error: {
          message: expect.stringContaining("Action request rejected"),
          code: "internal.unexpected",
          status: 500,
        },
      },
    })
  })

  test("keeps network errors distinct from HTTP errors", async () => {
    configureActionClient(() => {
      throw new Error("Network unavailable")
    })

    const result = await executeGlobalAction({
      path: { actionId: "approve" },
      body: {},
    })

    expect(result).toEqual({
      data: {
        success: false,
        error: { message: "Network unavailable" },
      },
    })
  })

  test("returns a discriminated success with a required run id", async () => {
    configureActionClient(() =>
      Response.json(
        {
          runId: "act_1",
          queuedAt: "2026-08-14T12:00:00.000Z",
          created: true,
        },
        { status: 202 }
      )
    )

    const result = await executeAction({
      path: { objectId: "Invoice~inv-1", actionId: "approve" },
      body: { params: { note: "Approved" } },
    })

    expect(result).toEqual({ data: { success: true, runId: "act_1" } })
  })
})
