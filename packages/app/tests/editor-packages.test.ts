import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editorPackageSplit } from "../src/editor-packages"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// The install a project pinning an older TipTap gets: @sixb/app's `@tiptap/pm` holds its own
// `prosemirror-view`, while `@tiptap/y-tiptap`, hoisted beside the project's, finds the project's.
async function install(options: { readonly appKeepsItsOwnView: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sixb-editor-packages-"))
  roots.push(root)
  const app = join(root, "node_modules", "@sixb", "app")
  const pm = join(app, "node_modules", "@tiptap", "pm")

  await writeManifest(root, { dependencies: { "@tiptap/pm": "^3.31.3", "@sixb/app": "0.2.6" } })
  await writeManifest(app, {
    name: "@sixb/app",
    dependencies: { "@tiptap/core": "^3.33.1", "@tiptap/pm": "^3.33.1", "@tiptap/y-tiptap": "^3" },
  })
  await writeManifest(pm, { name: "@tiptap/pm", dependencies: { "prosemirror-view": "^1.42.6" } })
  await writeManifest(join(root, "node_modules", "@tiptap", "y-tiptap"), {
    name: "@tiptap/y-tiptap",
    peerDependencies: { "prosemirror-view": "^1.9.10" },
  })
  await writeManifest(join(root, "node_modules", "prosemirror-view"), {
    name: "prosemirror-view",
    version: "1.42.3",
  })
  if (options.appKeepsItsOwnView) {
    await writeManifest(join(pm, "node_modules", "prosemirror-view"), {
      name: "prosemirror-view",
      version: "1.43.0",
    })
  }
  return root
}

test("names both copies of a package the editor shares, and the project's packages to move", async () => {
  const root = await install({ appKeepsItsOwnView: true })

  expect(editorPackageSplit(root, join(root, "node_modules", "@sixb", "app"))).toBe(
    "[SixbCustomApp] The app's editor would load more than one copy of prosemirror-view " +
      "1.42.3 and 1.43.0, and it works only with one. Move this project's @tiptap/* (^3.31.3) " +
      "to the versions @sixb/app uses (@tiptap/* ^3.33.1), then reinstall."
  )
})

test("an install where every editor package finds the same copy passes", async () => {
  const root = await install({ appKeepsItsOwnView: false })

  expect(editorPackageSplit(root, join(root, "node_modules", "@sixb", "app"))).toBeNull()
})

async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest))
}
