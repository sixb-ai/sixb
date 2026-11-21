import { dirname } from "node:path"

// The packages a document editor's state passes between modules. Each must load once per page:
// ProseMirror and Yjs check what they are handed with `instanceof`, so a value made by a second
// copy reads as foreign. A project that installs its own TipTap at another version gets exactly
// that: its package manager keeps two trees, and a package that imports `prosemirror-view` itself,
// as `@tiptap/y-tiptap` does, takes the project's copy while the app's editor runs on its own. The
// view then fails as it draws, on the first decoration set from the other copy.
//
// Each ProseMirror package is the copy `@tiptap/pm` loads from where @sixb/app resolves it, so the
// app's editor keeps the versions it was built against; Yjs is the one @sixb/app resolves.
const SINGLE_COPIES: Readonly<Record<string, string | null>> = {
  "prosemirror-model": "@tiptap/pm/model",
  "prosemirror-state": "@tiptap/pm/state",
  "prosemirror-transform": "@tiptap/pm/transform",
  "prosemirror-view": "@tiptap/pm/view",
  yjs: null,
}

/** Bundles every import of those packages from the copy found from `fromDir`. */
export function singleCopyPlugin(fromDir: string): Bun.BunPlugin {
  return {
    name: "sixb-single-copies",
    setup(build) {
      const paths = new Map<string, string>()
      for (const [name, via] of Object.entries(SINGLE_COPIES)) {
        const viaPath = via ? resolveFrom(via, fromDir) : fromDir
        const path = viaPath && resolveFrom(name, via ? dirname(viaPath) : viaPath)
        if (path) paths.set(name, path)
      }
      if (paths.size === 0) return

      // Match only the names found, so the hook always answers: returning `undefined` from a
      // resolve hook has corrupted Bun's dead-code elimination (see build.ts).
      const names = [...paths.keys()].map((name) => name.replaceAll("-", "\\-")).join("|")
      build.onResolve({ filter: new RegExp(`^(?:${names})$`) }, (args) => ({
        path: paths.get(args.path) as string,
      }))
    },
  }
}

function resolveFrom(specifier: string, dir: string): string | null {
  try {
    return Bun.resolveSync(specifier, dir)
  } catch {
    return null
  }
}
