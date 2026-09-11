import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { listProjectModules } from "@sixb/core/internal/bootstrap"

/** Bundle a project, including modules reachable only through convention-based discovery. */
export async function buildRuntime(entry: string, outdir: string): Promise<Bun.BuildOutput> {
  const projectRoot = dirname(entry)
  const modules = await listProjectModules(projectRoot)
  const generatedEntry = join(projectRoot, ".sixb", "build", "backend", basename(entry))
  const imports = modules.map(
    (module) =>
      `{ path: ${JSON.stringify(module.path)}, kind: ${JSON.stringify(module.kind)}, ` +
      `load: () => import(${JSON.stringify(resolve(projectRoot, module.path))}) }`
  )

  await mkdir(dirname(generatedEntry), { recursive: true })
  await writeFile(
    generatedEntry,
    `import { withProjectModules } from "@sixb/core/internal/bootstrap"

const projectRoot = process.cwd()
const modules = [${imports.join(",\n")}]
const config = await withProjectModules(projectRoot, modules, () => import(${JSON.stringify(entry)}))
const candidate = config.sixb ?? config.default
export const sixb = typeof candidate === "function"
  ? () => withProjectModules(projectRoot, modules, candidate)
  : candidate
export default sixb
`
  )

  return Bun.build({
    entrypoints: [generatedEntry],
    outdir,
    target: "bun",
    sourcemap: "external",
    minify: false,
    packages: "external",
    external: ["@sixb/*"],
  })
}
