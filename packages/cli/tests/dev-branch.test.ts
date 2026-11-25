import { afterEach, expect, test } from "bun:test"
import { BRANCH_KEY_HEADER, BRANCH_STATUS_PATH } from "@sixb/core/internal/branches"
import { startBranchFront } from "../src/lib/dev-branch"

const stops: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

const KEY = "k".repeat(43)

/** A branch's front, its API and its app, each answering with its own name. */
function setup() {
  const api = Bun.serve({ port: 0, fetch: () => new Response("api") })
  const app = Bun.serve({ port: 0, fetch: () => new Response("app") })
  stops.push(
    async () => api.stop(true),
    async () => app.stop(true)
  )
  const front = startBranchFront({
    branch: "feature/invoices",
    key: KEY,
    host: "127.0.0.1",
    port: 0,
    apiPort: api.port!,
    appPort: app.port!,
    root: process.cwd(),
  })
  stops.push(() => front.stop())

  const call = (path: string, key: string | null = KEY) =>
    fetch(`http://127.0.0.1:${front.port}${path}`, {
      headers: key ? { [BRANCH_KEY_HEADER]: key } : {},
    })
  const status = async () => (await (await call(BRANCH_STATUS_PATH)).json()) as { requests: number }
  return { front, call, status }
}

// Production stops a branch nobody uses, and learns of its use from this count only.
// Guard check: drop the `requests` count from `fetch` in `dev-branch.ts`.
test("counts what it forwards as use, and none of production's status reads", async () => {
  const { front, call, status } = setup()
  front.reporter.message({ type: "ready", watchesApp: false, app: null }, undefined)

  expect((await status()).requests).toBe(0)
  expect((await call("/api/objects")).status).toBe(200)
  expect((await call("/api/objects")).status).toBe(200)
  expect((await call("/api/objects", null)).status).toBe(401)
  expect((await status()).requests).toBe(2)
})

// A preview is the project's app on the branch's data: the front serves it beside the API.
// Guard check: send every path to the API in `upstream` (`dev-branch.ts`).
test("serves the project's app, and the API's paths from the API", async () => {
  const { front, call } = setup()
  front.reporter.message(
    {
      type: "ready",
      watchesApp: true,
      app: { url: "http://127.0.0.1", apiOrigin: "http://127.0.0.1" },
    },
    undefined
  )

  expect(await (await call("/")).text()).toBe("app")
  expect(await (await call("/invoices/42")).text()).toBe("app")
  expect(await (await call("/api/objects")).text()).toBe("api")
  expect(await (await call("/auth/sign-in")).text()).toBe("api")
  expect(await (await call("/health")).text()).toBe("api")
})

// The app serves its own framework files under `/__sixb/`: connector icons and live reload.
// Guard check: add "/__sixb/" back to `BRANCH_API_PREFIXES` in `core/src/branches/runtime.ts`.
test("leaves the app's own /__sixb/ files to the app, and answers its status itself", async () => {
  const { front, call } = setup()
  front.reporter.message(
    {
      type: "ready",
      watchesApp: true,
      app: { url: "http://127.0.0.1", apiOrigin: "http://127.0.0.1" },
    },
    undefined
  )

  expect(await (await call("/__sixb/assets/connector-icons/github.svg")).text()).toBe("app")
  expect(await (await call("/__sixb/dev-reload.js")).text()).toBe("app")

  const status = (await (await call(BRANCH_STATUS_PATH)).json()) as { state: string }
  expect(status.state).toBe("ready")
})

test("sends everything to the API when the project has no app", async () => {
  const { front, call } = setup()
  front.reporter.message({ type: "ready", watchesApp: false, app: null }, undefined)

  expect(await (await call("/")).text()).toBe("api")
})
