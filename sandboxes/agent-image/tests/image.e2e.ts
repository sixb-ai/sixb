import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const run = process.env.SIXB_AGENT_IMAGE_INTEGRATION === "1" ? test : test.skip
const version = (await readFile(resolve(import.meta.dir, "../VERSION"), "utf8")).trim()

run(
  "agent image creates and renders documents without network access",
  async () => {
    const output = await mkdtemp(join(tmpdir(), "sixb-agent-image-"))
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../verify.ts"),
          "--image",
          process.env.SIXB_AGENT_IMAGE ?? `sixb-agent:${version}`,
          "--output",
          output,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 360_000 }
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output: code === 0 ? "" : `${stdout}\n${stderr}` }).toEqual({
        code: 0,
        output: "",
      })
      const result = JSON.parse(await readFile(join(output, "qa/results.json"), "utf8"))
      expect(result.status).toBe("passed")
      expect(result.checks).toContain("scanned-pdf-ocr")
      expect(result.checks).toContain("browser-interaction-screenshot-pdf")
      expect(result.checks).toContain("offline-package-install")
      expect(result.artifacts.map((artifact: { file: string }) => artifact.file)).toEqual([
        "report.pdf",
        "slides.pptx",
        "edited.pptx",
        "report.docx",
        "costs.xlsx",
      ])
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  },
  420_000
)
