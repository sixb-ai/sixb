import { describe, expect, test } from "bun:test"
import {
  AppPackagesMissingError,
  AppPackagesSplitError,
  type CustomAppDevServer,
} from "@sixb/app/server"
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

  // Regression proof: drop AppPackagesSplitError from startDevApp's check and this rejects.
  test("a project installing two copies of an editor package keeps dev running, with the fix", async () => {
    const split =
      "[SixbCustomApp] The app's editor would load more than one copy of yjs 13.6.1 and 13.6.33."
    const started = await startDevApp(
      { dev: () => Promise.reject(new AppPackagesSplitError(split)) },
      options
    )

    expect(started.server).toBeNull()
    expect(started.warning).toBe(
      "The app's editor would load more than one copy of yjs 13.6.1 and 13.6.33."
    )
  })

  test("any other failure still stops dev", async () => {
    const failing = { dev: () => Promise.reject(new Error("Bundle failed")) }
    await expect(startDevApp(failing, options)).rejects.toThrow("Bundle failed")

    const server = { watchesSources: true } as CustomAppDevServer
    expect(await startDevApp({ dev: () => Promise.resolve(server) }, options)).toEqual({ server })
  })
})
