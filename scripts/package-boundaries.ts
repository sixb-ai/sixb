import { isBuiltin } from "node:module"
import { join } from "node:path"
import { type BunPlugin, Glob } from "bun"
import {
  type ExportTarget,
  internalDependencies,
  type PublishablePackage,
  packageName,
} from "./publishable-packages"

/**
 * One specifier, one file.
 *
 * A package artifact may import a sibling; it must never absorb one, and it must never resolve one
 * to a second copy. Both leave two modules where the code assumes one — the failure
 * `splitting: true` already guards against inside a package, now across a package boundary — and
 * an absorbed copy also carries the sibling's third-party imports out of the directory that
 * satisfies them.
 *
 * One resolver behaviour is behind both. Bun applies the `paths` map of the nearest
 * `tsconfig.json` to every import it resolves, `node_modules` included, and `packages: "external"`
 * judges the resolved path rather than the specifier. So the root map that turns `@sixb/ui` into
 * `packages/ui/src/index.ts` makes a sibling look like local source while we build, and sends a
 * built module back into that source while a consumer bundles. Neither can be waved off from the
 * call site: Bun reads the config sitting next to the file, not the one handed to `Bun.build`.
 *
 * Three assertions, one derivation, so they cannot drift:
 *
 * - `build-package.ts` settles every sibling on its specifier before the bundler resolves it, and
 *   writes the boundary that stops the map at `dist`.
 * - `pack-smoke.ts` rejects a package whose imports outrun its manifest, and a tarball that lost
 *   its boundary.
 * - `pack-smoke.ts` rejects a root `paths` map that stops mirroring `exports.bun` — the agreement
 *   that keeps this repo's own bundles down to one copy of each module.
 *
 * Stylesheets are out of scope. A bare `@import` in CSS is resolved by the consumer's Tailwind —
 * relative to the stylesheet, then up through `node_modules` — not by the module resolver, so
 * what a published stylesheet needs is declared by hand. `AGENTS.md` says so next to this rule.
 */

/**
 * The manifest fields that say what a package may import at runtime.
 *
 * Structural on purpose: the build script and the release gate each carry their own, wider
 * `PackageJson`, and only these fields matter here.
 */
export interface ManifestDependencies {
  readonly name?: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
}

export interface ImportScope {
  readonly directory: string
  readonly glob: string
}

export interface UndeclaredImport {
  readonly specifier: string
  readonly file: string
}

export interface AliasDrift {
  readonly specifier: string
  /** The `exports.bun` target, repo-relative. */
  readonly expected: string
  /** What the root `paths` map says instead, or `null` when it says nothing. */
  readonly actual: string | null
}

/**
 * `src` ships in the tarball and `exports.bun` points Bun consumers straight at it, so a source
 * import is a runtime import on someone else's machine — a devDependency there fails for them,
 * never for us. Every module extension, not only the TypeScript ones the repo happens to use.
 */
export const sourceScope: ImportScope = {
  directory: "src",
  glob: "**/*.{ts,tsx,js,jsx,mjs,cjs}",
}

/** What every non-Bun consumer loads. `Bun.build` emits `.js` and nothing else. */
export const artifactScope: ImportScope = { directory: "dist", glob: "**/*.js" }

/** The file that stops a `paths` map at a built artifact, relative to `artifactScope.directory`. */
export const resolutionBoundaryFile = "tsconfig.json"

/**
 * Write the resolution boundary into a built package directory.
 *
 * `dist` sits inside the package, so the nearest config above it is the one the package is
 * developed with — and in this repo that one maps every `@sixb/*` specifier back to source. A
 * config of its own is the only way to stop the lookup here; there is no "does not apply below"
 * to declare from above.
 *
 * This ships in the tarball rather than staying a repo detail, because the map that reaches a
 * built module belongs to whoever is bundling it. Measured on Bun 1.3.8 and 1.3.14, at build time
 * and at runtime, from a real `node_modules` install: without this file the consumer's `paths` map
 * applies inside our `dist`.
 */
export async function writeResolutionBoundary(directory: string): Promise<void> {
  await Bun.write(join(directory, resolutionBoundaryFile), resolutionBoundary)
}

/**
 * Matches this package's siblings, and only its siblings: each declared name, either whole or
 * followed by a subpath. `null` when the package has none.
 *
 * Siblings come from `internalDependencies` so the build and the release gate share one answer to
 * "what is a sibling". `pack-smoke.ts` already enforces that the two ways of asking — a `@sixb/*`
 * name and a `workspace:` range — always agree.
 */
export function siblingSpecifierPattern(manifest: ManifestDependencies): RegExp | null {
  const siblings = [...internalDependencies(manifest)].sort((a, b) => a.localeCompare(b))
  if (siblings.length === 0) return null

  return new RegExp(`^(?:${siblings.map(escapeRegExp).join("|")})(?:$|/)`)
}

/**
 * Resolves every sibling as a package, whatever else would have resolved it.
 *
 * This runs on the specifier as written, before the resolution `packages: "external"` judges and
 * before any alias can rewrite it — which is the only place the boundary can be settled.
 *
 * `external` patterns are the obvious alternative and cannot express this: measured against Bun
 * 1.3.14, an exact `"@sixb/ui"` loses to a `paths` alias and only a wildcard pre-empts it, so the
 * boundary would have to be written `"@sixb/ui*"` — which also captures `@sixb/ui-anything` and
 * would externalize a package the manifest never declared.
 */
export function workspaceBoundaryPlugins(manifest: ManifestDependencies): BunPlugin[] {
  const filter = siblingSpecifierPattern(manifest)
  if (!filter) return []

  return [
    {
      name: "sixb:workspace-boundary",
      setup(build) {
        build.onResolve({ filter }, ({ path }) => ({ path, external: true }))
      },
    },
  ]
}

/**
 * Bare specifiers under `scope` that the manifest does not declare, with the first file importing
 * each one.
 *
 * Bun's transpiler is the parser on purpose. Type-only imports have to erase — they resolve
 * against devDependencies legitimately — and `@sixb/app` emits real `import` lines inside a
 * template literal (the generated custom-app entry) that a regex reads as its own imports.
 */
export async function findUndeclaredImports(
  packageRoot: string,
  manifest: ManifestDependencies,
  scope: ImportScope
): Promise<UndeclaredImport[]> {
  const declared = declaredDependencies(manifest)
  const directory = join(packageRoot, scope.directory)
  const offenders = new Map<string, string>()

  for await (const file of scanFiles(directory, scope.glob)) {
    const contents = stripShebang(await Bun.file(join(directory, file)).text())

    for (const specifier of importedSpecifiers(contents, file)) {
      const owner = packageOwner(specifier)
      // A package may reference itself through its own `exports`; that resolves for consumers.
      if (!owner || owner === manifest.name || declared.has(owner) || offenders.has(owner)) continue
      offenders.set(owner, file)
    }
  }

  return [...offenders]
    .map(([specifier, file]) => ({ specifier, file }))
    .sort((a, b) => a.specifier.localeCompare(b.specifier))
}

/**
 * Source-first subpaths the root `paths` map no longer mirrors.
 *
 * The two are supposed to name the same file. `exports.bun` is the condition Bun picks for a
 * source-first subpath — here and in a user's project — and `paths` is what this repo's own
 * bundles resolve through, so while they agree a bundle holds one copy of each module. Let an
 * entry go missing and that one specifier resolves through `exports.import` instead: a second,
 * separately-configured copy in the same bundle, or an outright failure when `dist` is not built
 * yet. A `@sixb/client` subpath already went missing once and took the Atlas bundle with it.
 *
 * Subpaths whose `bun` target is not source are left out rather than special-cased: `create-sixb`
 * publishes only `dist` and points every condition there, so it has no source to mirror.
 */
export function findAliasDrift(
  packages: readonly PublishablePackage[],
  paths: Readonly<Record<string, readonly string[]>>
): AliasDrift[] {
  const drift: AliasDrift[] = []

  for (const packageInfo of packages) {
    for (const [specifier, expected] of sourceAliases(packageInfo)) {
      const actual = paths[specifier]?.join(", ") ?? null
      if (actual === expected) continue
      drift.push({ specifier, expected, actual })
    }
  }

  return drift.sort((a, b) => a.specifier.localeCompare(b.specifier))
}

/**
 * JSONC, which Bun accepts here, so the file can say what it is. It lands in every tarball and
 * reads as unexplained tooling otherwise.
 */
const resolutionBoundary = [
  "// Written by scripts/build-package.ts, and published on purpose.",
  "// Bun applies the nearest tsconfig paths map to every import it resolves, node_modules",
  "// included. An empty map here keeps a consumer's aliases from sending a module in this",
  "// directory back into a second copy of its own source.",
  '{ "compilerOptions": { "paths": {} } }',
  "",
].join("\n")

/** Every `[specifier, repo-relative target]` pair this package's `exports.bun` puts in source. */
function sourceAliases(packageInfo: PublishablePackage): Array<[string, string]> {
  const name = packageName(packageInfo)
  const aliases: Array<[string, string]> = []

  for (const [subpath, target] of subpathExports(packageInfo.packageJson.exports)) {
    const sources = bunSourceTargets(target)
    if (sources.length === 0) continue

    const specifier = subpath === "." ? name : `${name}/${subpath.slice(2)}`
    aliases.push([
      specifier,
      sources.map((source) => `./${packageInfo.dir}/${source.slice(2)}`).join(", "),
    ])
  }

  return aliases
}

/** `exports` as `[subpath, target]` pairs. An object of conditions alone is the root subpath. */
function subpathExports(exports: ExportTarget | undefined): Array<[string, ExportTarget]> {
  if (!exports) return []
  if (typeof exports === "string" || Array.isArray(exports)) return [[".", exports]]

  const entries = Object.entries(exports)
  return entries.every(([subpath]) => subpath.startsWith(".")) ? entries : [[".", exports]]
}

/** The `./src/` files a subpath's `bun` condition names, in the order it lists them. */
function bunSourceTargets(target: ExportTarget): string[] {
  if (!target || typeof target === "string" || Array.isArray(target)) return []

  const bun = target.bun
  const candidates = Array.isArray(bun) ? bun : [bun]
  return candidates.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.startsWith("./src/")
  )
}

/** Every package name this manifest promises will be installed alongside it. */
function declaredDependencies(manifest: ManifestDependencies): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
}

/**
 * A parse failure is a real finding, not something to step over: the gate cannot vouch for a file
 * it never read.
 */
function importedSpecifiers(contents: string, file: string): string[] {
  try {
    return transpilerFor(loaderFor(file))
      .scanImports(contents)
      .map(({ path }) => path)
  } catch (error) {
    throw new Error(`[SixbPublish] Could not parse ${file}: ${(error as Error).message}`)
  }
}

/** TypeScript generics and JSX are ambiguous, so the loader has to follow the extension. */
function loaderFor(file: string): SourceLoader {
  if (file.endsWith(".tsx")) return "tsx"
  if (file.endsWith(".ts")) return "ts"
  if (file.endsWith(".jsx")) return "jsx"
  return "js"
}

type SourceLoader = "ts" | "tsx" | "js" | "jsx"

const transpilers = new Map<SourceLoader, Bun.Transpiler>()

function transpilerFor(loader: SourceLoader): Bun.Transpiler {
  const existing = transpilers.get(loader)
  if (existing) return existing

  const created = new Bun.Transpiler({ loader })
  transpilers.set(loader, created)
  return created
}

/** `Glob.scan` throws on a missing root; a package without the directory has nothing to check. */
async function* scanFiles(directory: string, glob: string): AsyncGenerator<string> {
  try {
    yield* new Glob(glob).scan({ cwd: directory })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

/** The package a bare specifier installs from, or `null` when nothing has to be installed. */
function packageOwner(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null
  if (specifier === "bun" || specifier.startsWith("bun:")) return null
  if (isBuiltin(specifier)) return null

  const segments = specifier.split("/")
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** `@sixb/cli` ships a bin with a shebang, which the transpiler refuses to parse. */
function stripShebang(contents: string): string {
  if (!contents.startsWith("#!")) return contents
  const newline = contents.indexOf("\n")
  return newline === -1 ? "" : contents.slice(newline + 1)
}
