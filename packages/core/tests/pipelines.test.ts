import { describe, expect, test } from "bun:test"
import {
  col,
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
  Sixb,
} from "../src"
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

describe("definePipelineStep", () => {
  test("rejects empty ids", () => {
    expect(() => definePipelineStep("")).toThrow(PipelineError)
    expect(() => definePipelineStep("")).toThrow("Pipeline step id must not be empty")
  })

  test("rejects empty inputs", () => {
    expect(() => definePipelineStep("step").inputs({})).toThrow(PipelineError)
    expect(() => definePipelineStep("step").inputs({})).toThrow(
      "Pipeline step input dataset must contain at least one entry"
    )
  })

  test("rejects empty input names", () => {
    expect(() => definePipelineStep("step").inputs({ "  ": rawOrdersDataset } as never)).toThrow(
      PipelineError
    )
    expect(() => definePipelineStep("step").inputs({ "  ": rawOrdersDataset } as never)).toThrow(
      "Pipeline step input name must not be empty"
    )
  })

  test("rejects empty input dataset ids", () => {
    expect(() =>
      definePipelineStep("step").inputs({
        rawOrders: { kind: "dataset", id: "   ", schema: { columns: [] } },
      } as never)
    ).toThrow(PipelineError)
    expect(() =>
      definePipelineStep("step").inputs({
        rawOrders: { kind: "dataset", id: "   ", schema: { columns: [] } },
      } as never)
    ).toThrow("Pipeline step input dataset must not be empty")
  })

  test("rejects empty output dataset ids", () => {
    expect(() =>
      definePipelineStep("step")
        .inputs({ rawOrders: rawOrdersDataset })
        .output({ kind: "dataset", id: "   ", schema: { columns: [] } } as never)
    ).toThrow(PipelineError)
    expect(() =>
      definePipelineStep("step")
        .inputs({ rawOrders: rawOrdersDataset })
        .output({ kind: "dataset", id: "   ", schema: { columns: [] } } as never)
    ).toThrow("Pipeline step output dataset must not be empty")
  })

  test("builds a run step with snapshot output by default", () => {
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
  })

  test("supports append output mode", () => {
    const step = definePipelineStep("append-orders")
      .inputs({ rawOrders: rawOrdersDataset })
      .output(canonicalOrdersDataset, { mode: "append" })
      .run(async () => {})

    expect(step.mode).toBe("append")
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
  test("rejects empty ids", () => {
    expect(() => definePipeline("")).toThrow(PipelineError)
    expect(() => definePipeline("")).toThrow("Pipeline id must not be empty")
  })

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

describe("isPipelineDefinition", () => {
  test("returns true for valid sequential pipelines", () => {
    const pipeline = definePipeline("p1").then(makeRunStep())

    expect(isPipelineDefinition(pipeline)).toBe(true)
  })

  test("returns false for standalone steps", () => {
    expect(isPipelineStepDefinition(makeRunStep())).toBe(true)
    expect(isPipelineDefinition(makeRunStep())).toBe(false)
  })

  test("returns false for null", () => {
    expect(isPipelineDefinition(null)).toBe(false)
  })

  test("returns false for old batch pipeline shape", () => {
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
})

describe("Sixb pipeline registration", () => {
  test("exposes pipeline definitions and lookup by id", () => {
    const pipeline = definePipeline("normalize-orders").then(makeRunStep())

    const sixb = new Sixb({
      ontology: [Room],
      datasets: [rawOrdersDataset, canonicalOrdersDataset],
      pipelines: [pipeline],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.getPipelineDefinitions().map((d) => d.id)).toEqual(["normalize-orders"])
    expect(sixb.getPipelineById("normalize-orders")).toBe(pipeline)
    expect(sixb.getPipelineById("missing-pipeline")).toBeNull()
  })

  test("rejects duplicate pipeline ids", () => {
    const p1 = definePipeline("normalize-orders").then(makeRunStep("clean-orders"))
    const p2 = definePipeline("normalize-orders").then(
      definePipelineStep("clean-customers")
        .inputs({ rawCustomers: rawCustomersDataset })
        .output(canonicalCustomersDataset)
        .run(async () => {})
    )
    const pipelines: PipelineDefinition[] = [p1, p2]
    const runtimeDeps = createTestRuntimeDeps()

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [
            rawOrdersDataset,
            rawCustomersDataset,
            canonicalOrdersDataset,
            canonicalCustomersDataset,
          ],
          pipelines,
          ...runtimeDeps,
        })
    ).toThrow(RuntimeError)
    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [
            rawOrdersDataset,
            rawCustomersDataset,
            canonicalOrdersDataset,
            canonicalCustomersDataset,
          ],
          pipelines,
          ...runtimeDeps,
        })
    ).toThrow("Duplicate pipeline id: normalize-orders")
  })

  test("rejects empty pipeline graphs", () => {
    const pipeline = definePipeline("empty-pipeline")

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset, canonicalOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(RuntimeError)
    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset, canonicalOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("Pipeline 'empty-pipeline' must contain at least one step")
  })

  test("rejects duplicate step ids within one pipeline", () => {
    const firstStep = makeRunStep("duplicate-step")
    const secondStep = definePipelineStep("duplicate-step")
      .inputs({ orders: canonicalOrdersDataset })
      .output(orderInsightsDataset)
      .run(async () => {})
    const pipeline = definePipeline("orders").then(firstStep).then(secondStep)

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset, canonicalOrdersDataset, orderInsightsDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(RuntimeError)
    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset, canonicalOrdersDataset, orderInsightsDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("Pipeline 'orders' contains duplicate step id 'duplicate-step'")
  })

  test("rejects step input datasets not registered with the runtime", () => {
    const missingInputDataset = defineDataset("missing.orders", {
      schema: [col("id", "string")],
    })
    const step = definePipelineStep("normalize-orders")
      .inputs({ rawOrders: missingInputDataset })
      .output(canonicalOrdersDataset)
      .run(async () => {})
    const pipeline = definePipeline("orders").then(step)

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [canonicalOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(RuntimeError)
    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [canonicalOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(
      "Pipeline 'orders' step 'normalize-orders' input 'rawOrders' references unknown dataset 'missing.orders'"
    )
  })

  test("rejects step output datasets not registered with the runtime", () => {
    const pipeline = definePipeline("orders").then(makeRunStep())

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(RuntimeError)
    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow(
      "Pipeline 'orders' step 'normalize-orders' outputs unknown dataset 'canonical.orders'"
    )
  })

  test("rejects references to unregistered schedules", () => {
    const missing = defineSchedule("missing").cron("0 * * * *")
    const pipeline = definePipeline("orders").when(missing).then(makeRunStep())

    expect(
      () =>
        new Sixb<readonly []>({
          ontology: [],
          datasets: [rawOrdersDataset, canonicalOrdersDataset],
          pipelines: [pipeline],
          ...createTestRuntimeDeps(),
        })
    ).toThrow("Pipeline 'orders' references unknown schedule 'missing'")
  })
})
