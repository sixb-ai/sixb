import { logs, type SixbLogsPage } from "../src/logs"

logs
  .workflows()
  .run("wf-1")
  .level("info")
  .subscribe((line) => {
    const runId: string = line.context.run.id
    void runId
  })

const page: Promise<SixbLogsPage> = logs.actions().tail({ limit: 100 })
void page

// A run id is ambiguous without its primitive kind.
// @ts-expect-error run() is intentionally unavailable on the all-kinds builder.
logs.all().run("ambiguous-run-id")
