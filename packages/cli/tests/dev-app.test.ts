import { describe, expect, test } from "bun:test"
import { AppPackagesMissingError, type CustomAppDevServer } from "@sixb/app/server"
import { startDevApp } from "../src/commands/dev-runner"

const options = { host: "127.0.0.1", port: 3000 }

describe("sixb dev's app", () => {
  // A project without React still gets its API in dev. Regression proof: let startDevApp rethrow
  // AppPackagesMissingError and the first case rejects.
  test("a project missing the app's packages keeps dev running, with the install command", async () => {
    const started = await startDevApp(
      {
        dev: () => Promise.reject(new AppPackagesMissingError(["react", "react-dom"])),
      },
      options
    )

    expect(started.server).toBeNull()
    expect(started.warning).toBe(
      "The app needs react, react-dom in this project. Install them with: bun add react react-dom"
    )
  })

  test("any other failure still stops dev", async () => {
    const failing = { dev: () => Promise.reject(new Error("Bundle failed")) }
    await expect(startDevApp(failing, options)).rejects.toThrow("Bundle failed")

    const server = { watchesSources: true } as CustomAppDevServer
    expect(await startDevApp({ dev: () => Promise.resolve(server) }, options)).toEqual({ server })
  })
})
