import { describe, expect, test } from "bun:test"
import { ErrorResponseSchema, SharedOpenApiSchemas } from "../src/schemas/common"

/**
 * The error-response shape is written twice: once as the Zod schema Elysia validates against, and
 * once as a hand-written OpenAPI component, because inlining it repeats the whole shape at nearly
 * three hundred responses (it cost ~6,700 lines of document before it was named).
 *
 * Two copies drift, and this one drifted expensively: a second `ErrorResponse` component lived in
 * `schemas/objects.ts`, was spread after the shared components, and therefore won — so widening the
 * Zod schema changed the runtime contract while the document, the generated client and Atlas all
 * stayed on two fields. Nothing failed; the shape was simply wrong everywhere it was read.
 *
 * To check this has teeth, add a field to `ErrorResponseSchema` without adding it to the component,
 * or re-declare `ErrorResponse` in another `*OpenApiSchemas` object.
 */
describe("the ErrorResponse component matches its Zod schema", () => {
  const component = SharedOpenApiSchemas.ErrorResponse

  test("declares exactly the schema's fields", () => {
    expect(Object.keys(component.properties ?? {}).sort()).toEqual(
      Object.keys(ErrorResponseSchema.shape).sort()
    )
  })

  test("requires exactly the schema's required fields", () => {
    const required = Object.entries(ErrorResponseSchema.shape)
      .filter(([, field]) => !field.isOptional())
      .map(([name]) => name)
      .sort()

    expect([...component.required].sort()).toEqual(required)
  })

  test("is the only component declaring this name", async () => {
    // Every object spread into `components.schemas`, in the order `server.ts` spreads them. A later
    // one silently replaces an earlier one.
    const { ObjectQueryOpenApiSchemas } = await import("../src/schemas/objects")
    const others = Object.keys(ObjectQueryOpenApiSchemas ?? {})

    expect(others).not.toContain("ErrorResponse")
  })
})
