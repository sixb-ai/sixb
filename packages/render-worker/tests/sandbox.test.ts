import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Sandbox } from "@sixb/core"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { readSandboxFiles } from "../src/sandbox"

const sandboxes: Sandbox[] = []
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.destroy()))
})

/** Real bash on this host, keeping how much each command printed. */
async function sandbox() {
  const local = await new LocalSandboxFactory({ isolation: "none" }).create()
  sandboxes.push(local)
  const printed: number[] = []
  const run = local.runCommand.bind(local)
  Object.assign(local, {
    runCommand: async (...args: Parameters<Sandbox["runCommand"]>) => {
      const result = await run(...args)
      printed.push(result.stdout.length)
      return result
    },
  })
  return { sandbox: local, printed }
}

describe("files read back out of a render's sandbox", () => {
  // Reproduce by reading each file whole, in one command: the PDF's base64 is 2 MB of one
  // command's output, which a provider that keeps 1 MiB of it cuts off.
  test("come back whole, a piece at a time, no command printing a mebibyte", async () => {
    const { sandbox: local, printed } = await sandbox()
    const pdf = Buffer.alloc(1_500_000, 7)
    pdf.write("%PDF-1.7", 0)
    const small = Buffer.from("a small picture")
    writeFileSync(join(local.workingDirectory, "document.pdf"), pdf)
    writeFileSync(join(local.workingDirectory, "small.webp"), small)

    const [readPdf, readSmall, tooLarge, missing] = await readSandboxFiles(
      local,
      [
        { path: join(local.workingDirectory, "document.pdf"), bytes: pdf.length },
        { path: join(local.workingDirectory, "small.webp"), bytes: small.length },
        { path: join(local.workingDirectory, "document.pdf"), bytes: 5_000_000 },
        { path: join(local.workingDirectory, "gone.png"), bytes: 10 },
      ],
      { maxBytes: 4_000_000, signal: new AbortController().signal }
    )

    expect(Buffer.from(readPdf as Uint8Array).equals(pdf)).toBe(true)
    expect(Buffer.from(readSmall as Uint8Array).equals(small)).toBe(true)
    expect(tooLarge).toEqual({ error: "too_large" })
    expect(missing).toEqual({ error: "unreadable" })
    expect(printed.length).toBeGreaterThan(2)
    expect(Math.max(...printed)).toBeLessThan(1024 * 1024)
  })
})
