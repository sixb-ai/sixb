import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { devReloadResponse } from "../src/dev-reload"

async function browser(hidden = false) {
  const before = { generation: process.env.SIXB_DEV_GENERATION, ready: process.env.SIXB_DEV_READY }
  let script: string
  try {
    process.env.SIXB_DEV_GENERATION = "original"
    process.env.SIXB_DEV_READY = "1"
    script = await devReloadResponse(new Request("http://localhost/__sixb/dev-reload.js")).text()
  } finally {
    if (before.generation === undefined) delete process.env.SIXB_DEV_GENERATION
    else process.env.SIXB_DEV_GENERATION = before.generation
    if (before.ready === undefined) delete process.env.SIXB_DEV_READY
    else process.env.SIXB_DEV_READY = before.ready
  }
  const timers = new Map<number, { run: () => void; delay: number }>()
  let timerId = 0
  let listener: (() => void) | undefined
  const state = { generation: "original", ready: true, offline: false, requests: 0, reloads: 0 }
  const document = {
    visibilityState: hidden ? "hidden" : "visible",
    addEventListener(_type: string, callback: () => void) {
      listener = callback
    },
    removeEventListener() {
      listener = undefined
    },
  }
  const context = {
    window: {},
    document,
    AbortSignal,
    location: {
      reload() {
        state.reloads++
      },
    },
    async fetch() {
      state.requests++
      if (state.offline) throw new Error("offline")
      return new Response(null, {
        headers: state.ready ? { "x-sixb-dev-generation": state.generation } : {},
      })
    },
    setTimeout(run: () => void, delay: number) {
      const id = ++timerId
      timers.set(id, { run, delay })
      return id
    },
    clearTimeout(id: number) {
      timers.delete(id)
    },
  }
  runInNewContext(script, context)
  await Bun.sleep(0)
  return {
    state,
    timers,
    async next() {
      const entry = timers.entries().next().value
      if (!entry) throw new Error("No scheduled poll")
      timers.delete(entry[0])
      entry[1].run()
      await Bun.sleep(0)
    },
    async visible(value: boolean) {
      document.visibilityState = value ? "visible" : "hidden"
      listener?.()
      await Bun.sleep(0)
    },
    installAgain() {
      runInNewContext(script, context)
    },
  }
}

// Guard: remove hidden()'s early return in the served script; hidden tabs then
// make network requests and fail these assertions. No real timers/network needed.
test("dev reload pauses hidden tabs and resumes immediately on visibility", async () => {
  const page = await browser(true)
  expect(page.state.requests).toBe(0)
  await page.next()
  expect(page.state.requests).toBe(0)
  await page.visible(true)
  expect(page.state.requests).toBe(1)
  page.installAgain()
  expect(page.timers.size).toBe(1)
  await page.visible(false)
  await page.next()
  expect(page.state.requests).toBe(1)
})

// Guard: replace the exponential delay with 1000; the outage backoff assertion fails.
test("dev reload backs off outages and reloads once only after a changed generation is ready", async () => {
  const page = await browser()
  page.state.offline = true
  const delays: number[] = []
  for (let index = 0; index < 5; index++) {
    await page.next()
    delays.push([...page.timers.values()][0]!.delay)
  }
  expect(delays).toEqual([2000, 4000, 8000, 10000, 10000])
  page.state.offline = false
  page.state.generation = "replacement"
  page.state.ready = false
  await page.next()
  expect(page.state.reloads).toBe(0)
  page.state.ready = true
  await page.next()
  expect(page.state.reloads).toBe(1)
  expect(page.timers.size).toBe(0)
  await page.visible(true)
  expect(page.state.reloads).toBe(1)
})
