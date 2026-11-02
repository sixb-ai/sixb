import { afterAll, describe, expect, test } from "bun:test"
import { doppler } from "../src"

/**
 * Runs against a real Doppler project. It's skipped without these, and it adds and removes one
 * variable in that project's `dev` config:
 *
 *   DOPPLER_TOKEN=<a token that can write dev> DOPPLER_E2E_PROJECT=<project> bun run test:e2e
 */
const token = process.env.DOPPLER_TOKEN
const project = process.env.DOPPLER_E2E_PROJECT
const name = `SIXB_E2E_${crypto.randomUUID().replaceAll("-", "_").toUpperCase()}`

describe.skipIf(!token || !project)("Doppler", () => {
  afterAll(async () => {
    await fetch(`https://api.doppler.com/v3/configs/config/secrets?project=${project}&config=dev`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ project, config: "dev", secrets: { [name]: null } }),
    })
  })

  test("a value written can be named and read, without touching the others", async () => {
    const source = doppler({ project: project ?? "" })
    const before = await source.read("dev")

    await source.write("dev", { [name]: "pa$$word" })

    expect(await source.names("dev")).toContain(name)
    expect(await source.read("dev")).toEqual({ ...before, [name]: "pa$$word" })
  })
})
