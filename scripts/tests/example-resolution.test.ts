import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { getParsedCommandLineOfConfigFile, parseCommandLine, sys } from "typescript"

const repoRoot = resolve(import.meta.dir, "..", "..")
const examples = ["auth", "northline", "panasonic-ac", "roku-tv"] as const

describe("example TypeScript resolution", () => {
  for (const example of examples) {
    test(`${example} develops from source and clears source paths only for typecheck`, () => {
      const exampleRoot = join(repoRoot, "examples", example)
      const configPath = join(exampleRoot, "tsconfig.json")
      const runtime = parseConfig(configPath, [])
      const typecheck = parseConfig(configPath, ["--paths", "null"])
      const packageJson = JSON.parse(readFileSync(join(exampleRoot, "package.json"), "utf-8")) as {
        scripts?: Record<string, string>
      }

      // Proven by setting `compilerOptions.paths` to `{}` in one example: its case fails here.
      expect(runtime.options.paths?.["@sixb/client"]).toEqual(["./packages/client/src/index.ts"])
      expect(typecheck.options.paths).toBeUndefined()
      expect(packageJson.scripts?.typecheck).toContain("tsc --noEmit --paths null")
    })
  }
})

function parseConfig(path: string, args: string[]) {
  const commandLine = parseCommandLine(args)
  expect(commandLine.errors).toEqual([])

  const parsed = getParsedCommandLineOfConfigFile(path, commandLine.options, {
    ...sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(`[SixbTest] Failed to parse ${path}: ${diagnostic.messageText}`)
    },
  })
  if (!parsed) throw new Error(`[SixbTest] Failed to parse ${path}`)
  return parsed
}
