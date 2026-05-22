import { describe, expect, test } from "bun:test"
import { createS4RouteHarness } from "./helpers/fixtures"
import { lines, s4, s4Json } from "./helpers/s4"

describe("action routes", () => {
  test("lists action metadata and input schema files", async () => {
    const { runtime } = await createS4RouteHarness()

    expect(lines(await s4(runtime, "ls /pario/objects/Device/ac-123/actions"))).toEqual([
      "setMode*",
    ])
    expect(lines(await s4(runtime, "ls /pario/objects/Device/ac-123/actions/setMode"))).toEqual([
      "action.json",
      "input.schema.json",
    ])

    const action = await s4Json<{
      id: string
      name?: string
      description?: string
      inputSchemaPath: string
    }>(runtime, "cat /pario/objects/Device/ac-123/actions/setMode/action.json")
    expect(action).toEqual({
      id: "setMode",
      name: "setMode",
      description: "Set the device mode.",
      inputSchemaPath: "input.schema.json",
    })

    const directAction = await s4Json<{ id: string }>(
      runtime,
      "cat /pario/objects/Device/ac-123/actions/setMode"
    )
    expect(directAction.id).toBe("setMode")

    const schema = await s4Json<Record<string, unknown>>(
      runtime,
      "cat /pario/objects/Device/ac-123/actions/setMode/input.schema.json"
    )
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: {
          type: "string",
          enum: ["cool", "heat", "off"],
        },
      },
    })
  })

  test("invokes Pario actions", async () => {
    const { runtime } = await createS4RouteHarness()

    const invokeResult = await s4Json<{ status: string; value: { runId: string } }>(
      runtime,
      'invoke /pario/objects/Device/ac-123/actions/setMode --input \'{"mode":"cool"}\''
    )
    expect(invokeResult.status).toBe("accepted")
    expect(invokeResult.value.runId).toStartWith("act_")
  })
})
