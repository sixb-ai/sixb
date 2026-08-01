import { isBuiltin } from "node:module"
import { join } from "node:path"
import { type BunPlugin, Glob } from "bun"
import { internalDependencies } from "./publishable-packages"

/**
 * The manifest is the package boundary.
 *
 * A package artifact may import a sibling; it must never absorb one. When it does, the sibling's
 * third-party imports are emitted from a directory that cannot resolve them, and every module
 * identity inside the absorbed copy splits in two — the same failure `splitting: true` already
 * guards against within a single package, now across a package boundary.
 *
 * Nothing in the resolver enforces that. Bun's `packages: "external"` decides from the *resolved
 * path*, so any alias that turns `@sixb/ui` into `packages/ui/src/index.ts` makes a sibling look
 * like local source — and the root `tsconfig.json` `paths` map does exactly that whenever
 * `node_modules` has no entry for the specifier. The build cannot opt out of the map either: Bun
 * reads the `tsconfig.json` next to the source file, not the one handed to `Bun.build`.
 *
 * So the boundary is asserted twice, from one derivation so the two can never drift:
 * `build-package.ts` resolves every sibling as external before the bundler can decide, and
 * `pack-smoke.ts` rejects any package whose imports outrun what its manifest declares.
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
