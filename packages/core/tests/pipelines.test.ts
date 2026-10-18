import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineSchedule,
  events,
  isPipelineDefinition,
  isPipelineStepDefinition,
  type PipelineDefinition,
  PipelineError,
  prop,
  RuntimeError,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const rawOrdersDataset = defineDataset("raw.orders", {
  schema: [col("orderId", "string"), col("amount", "float64")],
})

const rawCustomersDataset = defineDataset("raw.customers", {
  schema: [col("customerId", "string")],
})

const canonicalOrdersDataset = defineDataset("canonical.orders", {
  schema: [col("id", "string"), col("amount", "float64")],
})

const canonicalCustomersDataset = defineDataset("canonical.customers", {
  schema: [col("id", "string")],
})

const orderInsightsDataset = defineDataset("insights.orders", {
  schema: [col("orders", "int64")],
})

function makeRunStep(id = "normalize-orders") {
  return definePipelineStep(id)
    .inputs({ rawOrders: rawOrdersDataset })
    .output(canonicalOrdersDataset)
    .run(async ({ inputs, output }) => {
      await output.writeRows(inputs.rawOrders.readRows())
    })
}

test.each([
  ["a step with an empty id", () => definePipelineStep(""), "Pipeline step id must not be empty"],
  [
    "a step with no inputs",
    () => definePipelineStep("step").inputs({}),
    "Pipeline step input dataset must contain at least one entry",
  ],
  [
    "a step with an empty input name",
    () => definePipelineStep("step").inputs({ "  ": rawOrdersDataset } as never),
    "Pipeline step input name must not be empty",
  ],
  [
    "a step with an empty input dataset id",
    () =>
      definePipelineStep("step").inputs({
        rawOrders: { kind: "dataset", id: "   ", schema: { columns: [] } },
      } as never),
    "Pipeline step input dataset must not be empty",
  ],
  [
    "a step with an empty output dataset id",
    () =>
      definePipelineStep("step")
        .inputs({ rawOrders: rawOrdersDataset })
        .output({ kind: "dataset", id: "   ", schema: { columns: [] } } as never),
    "Pipeline step output dataset must not be empty",
  ],
  ["a pipeline with an empty id", () => definePipeline(""), "Pipeline id must not be empty"],
] as const)("rejects %s", (_case, define, message) => {
  expect(define).toThrow(PipelineError)
  expect(define).toThrow(message)
})

describe("definePipelineStep", () => {
  test("builds a run step with snapshot output by default, or append when asked", () => {
    const step = makeRunStep()

    expect(step).toMatchObject({
      kind: "pipeline.step",
      id: "normalize-orders",
      inputs: { rawOrders: rawOrdersDataset },
      output: canonicalOrdersDataset,
      mode: "snapshot",
      executor: { kind: "run" },
    })
    if (step.executor.kind === "run") {
      expect(typeof step.executor.handler).toBe("function")
    }

    const append = definePipelineStep("append-orders")
      .inputs({ rawOrders: rawOrdersDataset })
      .output(canonicalOrdersDataset, { mode: "append" })
      .run(async () => {})
    expect(append.mode).toBe("append")
  })

  test("builds a SQL step with the default dialect", () => {
    const step = definePipelineStep("order-insights")
      .inputs({ orders: canonicalOrdersDataset })
      .output(orderInsightsDataset)
      .sql(({ orders }) => `select count(*) as orders from ${orders}`)

    expect(step.executor.kind).toBe("sql")
    expect(isPipelineStepDefinition(step)).toBe(true)
    if (step.executor.kind === "sql") {
      expect(step.executor.dialect).toBe("duckdb")
      expect(step.executor.sql({ orders: { toString: () => "orders_relation" } })).toBe(
        "select count(*) as orders from orders_relation"
      )
    }
  })
})

describe("definePipeline", () => {
  test("composes steps in sequence order", () => {
    const clean = makeRunStep("clean-orders")
    const insights = definePipelineStep("order-insights")
      .inputs({ orders: canonicalOrdersDataset })
      .output(orderInsightsDataset)
      .run(async () => {})

    const pipeline = definePipeline("orders").then(clean).then(insights)

    expect(pipeline.kind).toBe("pipeline")
    expect(pipeline.id).toBe("orders")
    expect(pipeline.triggers).toEqual([])
    expect(pipeline.graph).toEqual({
      kind: "sequence",
      nodes: [
        { kind: "step", step: clean },
        { kind: "step", step: insights },
      ],
    })
  })

  test("attaches cron and event schedules via .when()", () => {
    const hourly = defineSchedule("hourly").cron("0 * * * *")
    const rawOrdersUpdated = defineSchedule("raw-orders-updated").on(
      events.dataset(rawOrdersDataset).updated()
    )
    const pipeline = definePipeline("scheduled-pipeline")
      .when(hourly)
      .when(rawOrdersUpdated)
      .then(makeRunStep())

    expect(pipeline.triggers).toEqual([
      { type: "schedule", scheduleId: "hourly" },
      { type: "schedule", scheduleId: "raw-orders-updated" },
    ])
  })
})

test("isPipelineDefinition accepts sequential pipelines only", () => {
  expect(isPipelineDefinition(definePipeline("p1").then(makeRunStep()))).toBe(true)
  expect(isPipelineStepDefinition(makeRunStep())).toBe(true)
  expect(isPipelineDefinition(makeRunStep())).toBe(false)
  expect(isPipelineDefinition(null)).toBe(false)
  // The old batch pipeline shape.
  expect(
    isPipelineDefinition({
      kind: "pipeline",
      id: "p1",
      mode: "batch",
      sources: [],
      target: { kind: "dataset", dataset: rawOrdersDataset },
      handler: () => {},
    })
  ).toBe(false)
})

describe("SixbHost pipeline registration", () => {
  test("exposes pipeline definitions and lookup by id", () => {
    const pipeline = definePipeline("normalize-orders").then(makeRunStep())

    const sixb = createTestSixb({
      ontology: [Room],
      datasets: [rawOrdersDataset, canonicalOrdersDataset],
      pipelines: [pipeline],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.pipelines.list().map((d) => d.id)).toEqual(["normalize-orders"])
    expect(sixb.pipelines.getById("normalize-orders")).toBe(pipeline)
    expect(sixb.pipelines.getById("missing-pipeline")).toBeNull()
  })

  const missingInputDataset = defineDataset("missing.orders", {
    schema: [col("id", "string")],
  })

  test.each([
    [
      "duplicate pipeline ids",
      [rawOrdersDataset, rawCustomersDataset, canonicalOrdersDataset, canonicalCustomersDataset],
      [
        definePipeline("normalize-orders").then(makeRunStep("clean-orders")),
        definePipeline("normalize-orders").then(
          definePipelineStep("clean-customers")
            .inputs({ rawCustomers: rawCustomersDataset })
            .output(canonicalCustomersDataset)
            .run(async () => {})
        ),
      ],
      "Duplicate pipeline id: normalize-orders",
    ],
    [
      "empty pipeline graphs",
      [rawOrdersDataset, canonicalOrdersDataset],
      [definePipeline("empty-pipeline")],
      "Pipeline 'empty-pipeline' must contain at least one step",
    ],
    [
      "duplicate step ids within one pipeline",
      [rawOrdersDataset, canonicalOrdersDataset, orderInsightsDataset],
      [
        definePipeline("orders")
          .then(makeRunStep("duplicate-step"))
          .then(
            definePipelineStep("duplicate-step")
              .inputs({ orders: canonicalOrdersDataset })
              .output(orderInsightsDataset)
              .run(async () => {})
          ),
      ],
      "Pipeline 'orders' contains duplicate step id 'duplicate-step'",
    ],
    [
      "step input datasets not registered with the runtime",
      [canonicalOrdersDataset],
      [
        definePipeline("orders").then(
          definePipelineStep("normalize-orders")
            .inputs({ rawOrders: missingInputDataset })
            .output(canonicalOrdersDataset)
            .run(async () => {})
        ),
      ],
      "Pipeline 'orders' step 'normalize-orders' input 'rawOrders' references unknown dataset 'missing.orders'",
    ],
    [
      "step output datasets not registered with the runtime",
      [rawOrdersDataset],
      [definePipeline("orders").then(makeRunStep())],
      "Pipeline 'orders' step 'normalize-orders' outputs unknown dataset 'canonical.orders'",
    ],
    [
      "references to unregistered schedules",
      [rawOrdersDataset, canonicalOrdersDataset],
      [
        definePipeline("orders")
          .when(defineSchedule("missing").cron("0 * * * *"))
          .then(makeRunStep()),
      ],
      "Pipeline 'orders' references unknown schedule 'missing'",
    ],
  ] satisfies [
    string,
    DatasetDefinition[],
    PipelineDefinition[],
    string,
  ][])("rejects %s", (_case, datasets, pipelines, message) => {
    const start = () =>
      createTestSixb({ ontology: [], datasets, pipelines, ...createTestRuntimeDeps() })
    expect(start).toThrow(RuntimeError)
    expect(start).toThrow(message)
  })
})
