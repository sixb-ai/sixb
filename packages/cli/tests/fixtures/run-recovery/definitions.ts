import {
  col,
  defineConnector,
  defineDataset,
  definePipeline,
  definePipelineStep,
  defineSync,
} from "@sixb/core"

/** The project of the run recovery tests. `die` is where a test kills the process. */
export function createDefinitions(die: (point: "mid-read") => void) {
  const source = defineDataset("source", { schema: [col("id", "string")] })
  const orders = defineDataset("orders", { schema: [col("id", "string")] })
  const published = defineDataset("published", { schema: [col("id", "string")] })

  const erp = defineConnector("erp", {
    type: "test",
    connect() {
      return {}
    },
  })

  const ordersSync = defineSync("orders-sync", { mode: "append" })
    .checkpoint<string>()
    .from(erp)
    .read(async function* (_client, { checkpoint, setCheckpoint }) {
      yield { id: `after-${checkpoint ?? "start"}` }
      die("mid-read")
      setCheckpoint("read-once")
    })
    .intoDataset(orders)

  const fill = definePipelineStep("fill")
    .inputs({ source })
    .output(orders, { mode: "append" })
    .run(async ({ inputs, output }) => {
      await output.writeRows(inputs.source.readRows())
      die("mid-read")
    })

  const publish = definePipelineStep("publish")
    .inputs({ orders })
    .output(published)
    .sql(({ orders }) => `SELECT id FROM ${orders}`)

  const pipeline = definePipeline("orders-pipeline").then(fill).then(publish)

  return { source, orders, published, erp, ordersSync, pipeline }
}
