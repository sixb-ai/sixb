import { readdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { HYPERFRAMES_VERSION } from "../src/artifacts/frames/hyperframes"

// Copies the HyperFrames runtime a video's frame plays with, `@hyperframes/core`'s
// `hyperframe.runtime.iife.js`, from the exact version this package's devDependencies pin. It is
// committed, as the frame route serves it from source, and CI copies it again to check it is
// current: `bun run generate:hyperframes-runtime`. Only the runtime ships: the package's own
// dependencies weigh 60 MB, which a project that plays a video has no use for. It is kept as
// `.txt`, which every Bun loader reads as text.
//
// Beside it goes the notice of what it bundles: HyperFrames' license and those of the packages
// built into it, each found from the package that depends on it, at the version installed.

/**
 * The packages HyperFrames' runtime has built into it, each by the chain of packages that leads
 * to it from `@hyperframes/core`. On an upgrade, check the bundle still carries each, and nothing
 * new: their code keeps names such as postcss' `PostCSS received`, nanoid's `customAlphabet`,
 * picocolors' `createColors` and pretext's `breakableFitAdvance`.
 */
const BUNDLED: readonly (readonly string[])[] = [
  ["postcss"],
  ["postcss", "nanoid"],
  ["postcss", "picocolors"],
  ["@chenglou/pretext"],
]

const generatedDir = resolve(import.meta.dir, "../src/artifacts/frames/generated")

const fromCore = createRequire(resolve(import.meta.dir, "../package.json"))
const corePackage = fromCore.resolve("@hyperframes/core/package.json")
const core = await readPackage(corePackage)
if (core.version !== HYPERFRAMES_VERSION) {
  throw new Error(
    `[Sixb] @hyperframes/core is ${core.version}, but HYPERFRAMES_VERSION says ${HYPERFRAMES_VERSION}. Pin both, and the agent image's CLI, to one release.`
  )
}

const bundled = await Promise.all(
  BUNDLED.map(async (chain) => {
    let path = corePackage
    for (const name of chain) path = createRequire(path).resolve(`${name}/package.json`)
    return readPackage(path)
  })
)

const runtime = await readFile(fromCore.resolve("@hyperframes/core/runtime"), "utf8")
const credits = bundled.map(
  (each) => `${each.name} ${each.version} (${each.license}, ${each.copyright})`
)
const banner = `/*! HyperFrames runtime ${core.version}, from @hyperframes/core (${core.license}): https://github.com/heygen-com/hyperframes. It bundles ${credits.join("; ")}. Their licenses: frames/generated/hyperframes-notices.txt in @sixb/core's source. */`
await write("hyperframes.txt", `${banner}\n${runtime}`)

const notices = [core, ...bundled].map((each) =>
  [`${each.name} ${each.version} (${each.license})`, "", each.text.trim()].join("\n")
)
await write(
  "hyperframes-notices.txt",
  `What the HyperFrames runtime in hyperframes.txt is made of, and the license of each part.\n\n${notices.join(`\n\n${"-".repeat(80)}\n\n`)}\n`
)

/** A package's name, version and license, the text of its license file, and its copyright. */
async function readPackage(packageJson: string) {
  const { name, version, license } = JSON.parse(await readFile(packageJson, "utf8")) as {
    readonly name: string
    readonly version: string
    readonly license?: string
  }
  const directory = dirname(packageJson)
  const file = (await readdir(directory)).find((entry) => /^licen[cs]e(\.|$)/i.test(entry))
  if (!file) throw new Error(`[Sixb] ${name} ${version} ships no license file to credit it by.`)

  const text = await readFile(join(directory, file), "utf8")
  // HyperFrames' package names no license: its file is the Apache License's text.
  const spdx = license ?? (/Apache License\s+Version 2\.0/.test(text) ? "Apache-2.0" : undefined)
  if (!spdx) throw new Error(`[Sixb] ${name} ${version} names no license to credit it by.`)

  const copyright = /^.*Copyright.*$/m.exec(text)?.[0].trim() ?? `the ${name} authors`
  return { name, version, license: spdx, text, copyright }
}

async function write(name: string, body: string) {
  const path = join(generatedDir, name)
  await writeFile(path, body)
  console.log(`[Sixb] Generated ${path} (${Math.round(body.length / 1024)} KB)`)
}
