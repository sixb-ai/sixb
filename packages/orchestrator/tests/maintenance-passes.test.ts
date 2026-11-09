import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  definePipeline,
  definePipelineStep,
  defineSchedule,
  events,
} from "@sixb/core"
import { compileRoutes } from "../src/compile-routes"
import { datasetTriggers } from "../src/maintenance-passes"

const orders = defineDataset("raw.orders", { schema: [col("id", "string")] })
const report = defineDataset("orders.report", { schema: [col("id", "string")] })

const ordersUpdated = defineSchedule("orders.updated").on(events.dataset(orders).updated())
const daily = defineSchedule("orders.daily").cron("0 2 * * *")

const buildReport = definePipeline("build-report")
  .when(ordersUpdated)
  .then(
    definePipelineStep("report")
      .inputs({ orders })
      .output(report)
      .run(() => {})
  )

const TRIGGER = {
  pipelineId: buildReport.id,
  scheduleId: ordersUpdated.id,
  datasetId: orders.id,
}

describe("datasetTriggers", () => {
  test("lists a pipeline's dataset schedules, and leaves out everything else", () => {
    const syncOnly = definePipeline("cron-only")
      .when(daily)
      .then(
        definePipelineStep("copy")
          .inputs({ orders })
          .output(report)
          .run(() => {})
      )

    const routes = compileRoutes({
      schedules: [ordersUpdated, daily],
      syncs: [],
      pipelines: [buildReport, syncOnly],
    })

    expect(datasetTriggers(routes)).toEqual([TRIGGER])
  })

  test("names a pipeline once per dataset, however many schedules name both", () => {
    const again = defineSchedule("orders.updated.again").on(events.dataset(orders).updated())
    const twice = definePipeline("twice")
      .when(ordersUpdated)
      .when(again)
      .then(
        definePipelineStep("copy")
          .inputs({ orders })
          .output(report)
          .run(() => {})
      )

    const routes = compileRoutes({
      schedules: [ordersUpdated, again],
      syncs: [],
      pipelines: [twice],
    })

    expect(datasetTriggers(routes)).toHaveLength(1)
  })
})
