import { describe, expect, test } from "bun:test"
import type { GetPipelineResponse } from "@sixb/client"
import { layoutPipeline } from "../src/pages/data/pipeline-canvas"

type Step = GetPipelineResponse["graph"]["nodes"][number]["step"]

const dataset = (id: string) => ({
  id,
  schema: { columns: [{ name: "id", type: "string" as const }] },
})

const step = (id: string, inputs: readonly string[], output: string): Step =>
  ({
    id,
    mode: "snapshot",
    executor: { kind: "sql", dialect: "duckdb" },
    inputs: inputs.map((input) => ({ name: input, dataset: dataset(input) })),
    output: dataset(output),
  }) as Step

const pipeline = (steps: readonly Step[]) =>
  ({
    id: "revenue",
    triggers: [],
    graph: { kind: "sequence", nodes: steps.map((entry) => ({ kind: "step", step: entry })) },
  }) as unknown as GetPipelineResponse

function columnsOf(input: GetPipelineResponse): Record<string, number> {
  return Object.fromEntries(
    layoutPipeline(input).nodes.map((node) => [node.id, node.position.x / 280])
  )
}

describe("pipeline canvas layout", () => {
  // Regression proof: place each step one column past its first input instead of its furthest,
  // and `rank` lands in `join`'s column, left of `revenue`, the dataset it reads.
  test("each step sits past its furthest input, and writes one column further", () => {
    const columns = columnsOf(
      pipeline([
        step("join", ["crm.deals", "payments.orders"], "revenue"),
        step("rank", ["crm.deals", "revenue"], "tiers"),
      ])
    )
    expect(columns).toEqual({
      "dataset:crm.deals": 0,
      "dataset:payments.orders": 0,
      "step:join": 1,
      "dataset:revenue": 2,
      "step:rank": 3,
      "dataset:tiers": 4,
    })
  })

  test("edges run from each input to its step and from the step to its output", () => {
    const { edges } = layoutPipeline(pipeline([step("join", ["a", "b"], "c")]))
    expect(edges.map((edge) => `${edge.source} -> ${edge.target}`)).toEqual([
      "dataset:a -> step:join",
      "dataset:b -> step:join",
      "step:join -> dataset:c",
    ])
  })
})
