import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"

// ProseMirror and Yjs check what they are handed with `instanceof`, so the app's document editor
// works only when every package it is built from shares one copy of each. A project that installs
// its own TipTap at another version can keep two dependency trees: `@tiptap/y-tiptap`, which
// imports ProseMirror itself, then takes the project's copy while the editor runs on the copy
// `@tiptap/pm` loads, and the editor fails as it draws. The package manager owns how many copies
// are installed, so the app does not pick one: before it bundles, it names the split and the
// dependencies to align.
const SINGLE_COPY = new Set([
  "prosemirror-model",
  "prosemirror-state",
  "prosemirror-transform",
  "prosemirror-view",
  "yjs",
])
/** The packages an editor is built from, which are all the walk needs to follow. */
const EDITOR_PACKAGE = /^(?:@tiptap\/|prosemirror-|yjs$|y-protocols$)/

interface Manifest {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
}

/**
 * Why the app's editor would load more than one copy of a package it shares, or `null` when it
 * would not. It follows the editor's packages from @sixb/app (`appPackageDir`) and the Sixb
 * packages it depends on, finding each package's dependencies and peers from where that package is
 * installed, as the resolver does.
 */
export function editorPackageSplit(rootDir: string, appPackageDir: string): string | null {
  // Each shared package's copies: its version in each folder it is installed in.
  const copies = new Map<string, Map<string, string>>()
  const seen = new Set<string>()
  const pending = [realpathSync(appPackageDir)]

  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const manifest = readManifest(dir)
    if (!manifest) continue
    if (manifest.name && SINGLE_COPY.has(manifest.name)) {
      const found = copies.get(manifest.name) ?? new Map<string, string>()
      copies.set(manifest.name, found.set(dir, manifest.version ?? "?"))
    }

    for (const dependency of new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])) {
      if (!EDITOR_PACKAGE.test(dependency) && !dependency.startsWith("@sixb/")) continue
      const installed = installedPackageDir(dependency, dir)
      if (installed) pending.push(installed)
    }
  }

  const splits = [...copies]
    .filter(([, found]) => found.size > 1)
    .map(([name, found]) => {
      const versions = [...new Set(found.values())]
      return versions.length > 1
        ? `${name} ${versions.join(" and ")}`
        : `${name} ${versions[0]} (installed ${found.size} times)`
    })
  if (splits.length === 0) return null

  return (
    `[SixbCustomApp] The app's editor would load more than one copy of ${splits.join(", ")}, ` +
    `and it works only with one. ${remedy(rootDir, appPackageDir)}`
  )
}

/** Names the project's own editor packages, which usually hold the second copy in place. */
function remedy(rootDir: string, appPackageDir: string): string {
  const project = readManifest(rootDir)
  const own = Object.entries({ ...project?.dependencies, ...project?.optionalDependencies }).filter(
    ([name]) => EDITOR_PACKAGE.test(name)
  )
  if (own.length === 0) return "Reinstall the project's packages to settle each on one version."

  const ranges = new Set(own.map(([, range]) => range))
  const tiptapOnly = own.every(([name]) => name.startsWith("@tiptap/"))
  const named =
    tiptapOnly && ranges.size === 1
      ? `@tiptap/* (${[...ranges][0]})`
      : own.map(([name, range]) => `${name}@${range}`).join(", ")
  const appTiptap = readManifest(appPackageDir)?.dependencies?.["@tiptap/core"]
  const target = appTiptap ? ` (@tiptap/* ${appTiptap})` : ""
  return `Move this project's ${named} to the versions @sixb/app uses${target}, then reinstall.`
}

/** Where `name` is installed as seen from `fromDir`, found up its `node_modules` folders. */
function installedPackageDir(name: string, fromDir: string): string | null {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
    if (dirname(dir) === dir) return null
  }
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest
  } catch {
    return null
  }
}
