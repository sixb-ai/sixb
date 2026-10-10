import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createSixb, defineObjectType, prop } from "../src"
import { discoverOntologyTypeManifest, isAgentContextPath } from "../src/bootstrap"
import { createOntologyDocsCatalog } from "../src/ontology/docs"
import { renderOntologyDocs } from "../src/ontology/docs-markdown"
import type { ObjectType } from "../src/ontology/types"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sixb-agent-project-context-"))
  roots.push(root)
  return root
}

async function writeProjectFile(
  root: string,
  path: string,
  contents: string | Uint8Array
): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), contents)
}

function skillMarkdown(frontmatter: readonly string[], body = "# Instructions"): string {
  return ["---", ...frontmatter, "---", "", body].join("\n")
}

function load(root: string) {
  return createSixb({ projectRoot: root, ontologies: [Room], ...createTestRuntimeDeps() })
}

describe("Agent Skills discovery", () => {
  test("a project without skills/ has none", async () => {
    const sixb = await load(await projectRoot())
    expect(sixb.definitions.skills.list()).toEqual([])
  })

  test("parses YAML metadata and keeps binary files and executable modes", async () => {
    const root = await projectRoot()
    await writeProjectFile(
      root,
      "skills/acme-style/SKILL.md",
      skillMarkdown([
        'name: "acme-style"',
        "description: >",
        "  Use when drafting Acme customer-facing",
        "  messages.",
        "compatibility: Ignored but preserved in SKILL.md.",
      ])
    )
    await writeProjectFile(root, "skills/acme-style/assets/template.bin", new Uint8Array([0, 255]))
    await writeProjectFile(root, "skills/acme-style/scripts/validate.sh", "#!/bin/sh\nexit 0\n")
    await chmod(join(root, "skills/acme-style/scripts/validate.sh"), 0o755)

    const skill = (await load(root)).definitions.skills.getByName("acme-style")
    expect(skill?.description).toBe("Use when drafting Acme customer-facing messages.")
    const file = (path: string) => skill?.files.find((candidate) => candidate.path === path)
    expect(skill?.files).toHaveLength(3)
    expect(file("SKILL.md")?.contents).toContain("# Instructions")
    expect(file("assets/template.bin")?.contents).toEqual(new Uint8Array([0, 255]))
    expect(file("assets/template.bin")?.mode).toBeUndefined()
    expect(file("scripts/validate.sh")?.mode).toBe(0o755)
  })

  test.each([
    {
      label: "an unquoted ': ' in a value",
      files: {
        "skills/acme-style/SKILL.md": skillMarkdown([
          "name: acme-style",
          "description: Use when: drafting messages",
        ]),
      },
      error: `Quote values that contain ': ', for example description: "Use when: ...".`,
    },
    {
      label: "a missing description",
      files: { "skills/acme-style/SKILL.md": skillMarkdown(["name: acme-style"]) },
      error: "SKILL.md frontmatter must include a non-empty string description.",
    },
    {
      label: "a name that differs from its directory",
      files: {
        "skills/acme-style/SKILL.md": skillMarkdown([
          "name: acme-voice",
          "description: Use when drafting messages.",
        ]),
      },
      error: "Skill name 'acme-voice' must match directory 'acme-style'.",
    },
    {
      label: "the reserved prefix",
      files: {
        "skills/sixb-custom/SKILL.md": skillMarkdown([
          "name: sixb-custom",
          "description: Invalid use of the reserved prefix.",
        ]),
      },
      error: "uses the reserved 'sixb-' prefix",
    },
    {
      label: "a missing SKILL.md",
      files: { "skills/acme-style/README.md": "# Acme" },
      error:
        "[Sixb] Agent Skill 'skills/acme-style' is invalid: Missing required regular SKILL.md.",
    },
  ])("fails createSixb on $label", async ({ files, error }) => {
    const root = await projectRoot()
    for (const [path, contents] of Object.entries(files)) {
      await writeProjectFile(root, path, contents)
    }
    await expect(load(root)).rejects.toThrow(error)
  })

  test("rejects symlinks instead of copying their targets", async () => {
    const root = await projectRoot()
    await writeProjectFile(
      root,
      "skills/acme-style/SKILL.md",
      skillMarkdown(["name: acme-style", "description: Use when drafting messages."])
    )
    await writeProjectFile(root, "secret.md", "secret")
    await symlink(join(root, "secret.md"), join(root, "skills/acme-style/leak.md"))

    await expect(load(root)).rejects.toThrow("Skill file 'leak.md' must not be a symlink.")
  })

  test("leaves out dependency folders and dotfiles", async () => {
    const root = await projectRoot()
    await writeProjectFile(
      root,
      "skills/acme-style/SKILL.md",
      skillMarkdown(["name: acme-style", "description: Use when drafting messages."])
    )
    for (const path of [".env", ".venv/lib.py", "node_modules/x/index.js", "__pycache__/a.pyc"]) {
      await writeProjectFile(root, `skills/acme-style/${path}`, "ignored")
    }
    await writeProjectFile(root, "skills/.DS_Store", "ignored")

    const skills = (await load(root)).definitions.skills.list()
    expect(skills.map((skill) => skill.files.map((file) => file.path))).toEqual([["SKILL.md"]])
  })

  test("caps the total size of skill files", async () => {
    const root = await projectRoot()
    await writeProjectFile(
      root,
      "skills/acme-style/SKILL.md",
      skillMarkdown(["name: acme-style", "description: Use when drafting messages."])
    )
    await writeProjectFile(
      root,
      "skills/acme-style/assets/large.bin",
      new Uint8Array(17 * 1024 * 1024)
    )

    await expect(load(root)).rejects.toThrow("[Sixb] The files under skills/ exceed 16 MB.")
  })
})

describe("SIXB.md discovery", () => {
  test("is optional", async () => {
    const sixb = await load(await projectRoot())
    expect(sixb.definitions.projectInstructions).toBeUndefined()
  })

  test("keeps the instructions verbatim", async () => {
    const root = await projectRoot()
    const instructions = "# Acme\n\nAnswer in French.\n"
    await writeProjectFile(root, "SIXB.md", instructions)
    expect((await load(root)).definitions.projectInstructions).toBe(instructions)
  })

  test("rejects a symlink", async () => {
    const root = await projectRoot()
    await writeProjectFile(root, "AGENTS.md", "Answer in French.")
    await symlink(join(root, "AGENTS.md"), join(root, "SIXB.md"))
    await expect(load(root)).rejects.toThrow(
      "[Sixb] SIXB.md must be a regular file, not a symlink or a directory."
    )
  })

  test.each([
    { label: "empty", contents: " \n\n", error: "[Sixb] SIXB.md is empty." },
    {
      label: "too large",
      contents: "x".repeat(32 * 1024 + 1),
      error: "[Sixb] SIXB.md is 32,769 bytes; the limit is 32,768.",
    },
    {
      label: "not UTF-8",
      contents: new Uint8Array([0x23, 0x20, 0xff, 0xfe]),
      error: "[Sixb] SIXB.md must be UTF-8 text.",
    },
  ])("fails createSixb when $label", async ({ contents, error }) => {
    const root = await projectRoot()
    await writeProjectFile(root, "SIXB.md", contents)
    await expect(load(root)).rejects.toThrow(error)
  })
})

function objectTypeModule(...ids: readonly string[]): string {
  return [
    `import { defineObjectType, prop } from "${coreModuleUrl}"`,
    ...ids.map(
      (id) =>
        `export const ${id} = defineObjectType({ id: "${id}", name: "${id}", ` +
        `properties: [prop("id", "string", { required: true, primary: true })] })`
    ),
  ].join("\n")
}

describe("ontology docs discovery", () => {
  test("names each type's doc after the module that defines it", async () => {
    const root = await projectRoot()
    await writeProjectFile(root, "ontology/crm.ts", objectTypeModule("Customer", "Payment"))
    await writeProjectFile(root, "ontology/billing/invoice.ts", objectTypeModule("Invoice"))
    // A barrel re-exports every type; it must not claim them.
    await writeProjectFile(
      root,
      "ontology/index.ts",
      'export * from "./crm"\nexport * from "./billing/invoice"\n'
    )
    await writeProjectFile(root, "ontology/billing/invoice.md", "Invoices are numbered yearly.")
    await writeProjectFile(root, "ontology/conventions.md", "# Naming conventions\n")

    const docs = (await createSixb({ projectRoot: root, ...createTestRuntimeDeps() })).definitions
      .ontologyDocs
    expect(docs.docPathFor("Invoice")).toBe("billing/invoice.md")
    expect(docs.docPathFor("Customer")).toBe("crm/Customer.md")
    expect(docs.docPathFor("Payment")).toBe("crm/Payment.md")
    expect(docs.notesFor("Invoice")).toEqual([
      { path: "billing/invoice.md", contents: "Invoices are numbered yearly." },
    ])
    expect(docs.notesFor("Customer")).toEqual([])
    expect(docs.listDocs()).toEqual([
      { path: "conventions.md", contents: "# Naming conventions\n" },
    ])
  })

  test("mounts scripts as written and never imports them as definitions", async () => {
    // Reproduce: stop skipping `scripts/` in listOntologyModuleFiles and both loads fail on the
    // throwing module.
    const root = await projectRoot()
    await writeProjectFile(root, "ontology/room.ts", objectTypeModule("Room"))
    await writeProjectFile(
      root,
      "ontology/billing/scripts/import.ts",
      'throw new Error("ontology scripts must not be imported")'
    )
    await writeProjectFile(root, "ontology/billing/scripts/run.sh", "#!/bin/sh\n")
    await chmod(join(root, "ontology/billing/scripts/run.sh"), 0o755)
    await writeProjectFile(root, "ontology/billing/scripts/README.md", "# Billing scripts\n")

    const sixb = await createSixb({ projectRoot: root, ...createTestRuntimeDeps() })
    expect(sixb.definitions.ontology.listObjectTypes().map((type) => type.id)).toEqual(["Room"])
    expect(sixb.definitions.ontologyDocs.listDocs()).toEqual([])
    expect(
      sixb.definitions.ontologyDocs.listScripts().map(({ path, mode }) => ({ path, mode }))
    ).toEqual([
      { path: "billing/scripts/import.ts", mode: undefined },
      { path: "billing/scripts/README.md", mode: undefined },
      { path: "billing/scripts/run.sh", mode: 0o755 },
    ])
    expect((await discoverOntologyTypeManifest(root)).moduleCount).toBe(1)
  })

  test.each([
    {
      label: "a symlinked file in scripts/",
      setup: async (root: string) => {
        await writeProjectFile(root, "secret.sh", "secret")
        await mkdir(join(root, "ontology/billing/scripts"), { recursive: true })
        await symlink(join(root, "secret.sh"), join(root, "ontology/billing/scripts/run.sh"))
      },
      error: "[Sixb] Ontology path 'ontology/billing/scripts/run.sh' must not be a symlink.",
    },
    {
      label: "a symlinked scripts/ folder",
      setup: async (root: string) => {
        await writeProjectFile(root, "tools/run.sh", "#!/bin/sh\n")
        await mkdir(join(root, "ontology/billing"), { recursive: true })
        await symlink(join(root, "tools"), join(root, "ontology/billing/scripts"))
      },
      error: "[Sixb] Ontology path 'ontology/billing/scripts' must not be a symlink.",
    },
    {
      label: "a symlinked folder",
      setup: async (root: string) => {
        await writeProjectFile(root, "shared/notes.md", "# Shared")
        await mkdir(join(root, "ontology"), { recursive: true })
        await symlink(join(root, "shared"), join(root, "ontology/shared"))
      },
      error: "[Sixb] Ontology path 'ontology/shared' must not be a symlink.",
    },
    {
      label: "too many bytes of docs and scripts",
      setup: (root: string) =>
        writeProjectFile(root, "ontology/scripts/model.bin", new Uint8Array(17 * 1024 * 1024)),
      error: "[Sixb] The files under ontology/ exceed 16 MB.",
    },
    {
      label: "a symlinked doc",
      setup: async (root: string) => {
        await writeProjectFile(root, "secret.md", "secret")
        await mkdir(join(root, "ontology"), { recursive: true })
        await symlink(join(root, "secret.md"), join(root, "ontology/leak.md"))
      },
      error: "[Sixb] Ontology path 'ontology/leak.md' must not be a symlink.",
    },
    {
      label: "a doc that is not UTF-8",
      setup: (root: string) =>
        writeProjectFile(root, "ontology/notes.md", new Uint8Array([0x23, 0xff, 0xfe])),
      error: "[Sixb] Ontology doc 'ontology/notes.md' must be UTF-8 text.",
    },
  ])("fails createSixb on $label", async ({ setup, error }) => {
    const root = await projectRoot()
    await setup(root)
    await expect(load(root)).rejects.toThrow(error)
  })

  test("rejects two files whose paths only differ by case", () => {
    // billing.ts defines two types, so Invoice's doc is billing/Invoice.md; Refund's single-type
    // module claims billing/invoice.md, the same file on a case-insensitive filesystem.
    expect(() =>
      createOntologyDocsCatalog({
        objectTypes: ["Invoice", "Payment", "Refund"].map(objectType),
        docs: {
          modules: [
            { path: "billing.ts", objectTypeIds: ["Invoice", "Payment"] },
            { path: "billing/invoice.ts", objectTypeIds: ["Refund"] },
          ],
          docs: [],
          scripts: [],
        },
      })
    ).toThrow(
      "[Sixb] The doc of object type 'Refund' at 'ontology/billing/invoice.md' collides with the doc of object type 'Invoice', which only differs by case or not at all. Rename one of them."
    )
    expect(() =>
      createOntologyDocsCatalog({
        objectTypes: [],
        docs: {
          modules: [],
          docs: [
            { path: "Conventions.md", contents: "" },
            { path: "conventions.md", contents: "" },
          ],
          scripts: [],
        },
      })
    ).toThrow(
      "[Sixb] The ontology docs 'ontology/Conventions.md' and 'ontology/conventions.md' only differ by case."
    )
  })
})

describe("ontology doc attribution", () => {
  // Reproduce: drop the module-name and `index` ranks in ontology/docs.ts and the barrels below
  // claim the types, which turns their notes into docs mounted for every reader.
  test("a barrel never takes a type from the module named after it", () => {
    const docs = createOntologyDocsCatalog({
      objectTypes: ["Invoice", "EmailThread"].map(objectType),
      docs: {
        modules: [
          { path: "index.ts", objectTypeIds: ["Invoice"] },
          { path: "communications/email-thread.ts", objectTypeIds: ["EmailThread"] },
          { path: "communications/index.ts", objectTypeIds: ["EmailThread"] },
          { path: "types/invoice.ts", objectTypeIds: ["Invoice"] },
        ],
        docs: [{ path: "types/invoice.md", contents: "Numbered yearly." }],
        scripts: [],
      },
    })
    expect(docs.docPathFor("Invoice")).toBe("types/invoice.md")
    expect(docs.docPathFor("EmailThread")).toBe("communications/email-thread.md")
    expect(docs.notesFor("Invoice").map((note) => note.contents)).toEqual(["Numbered yearly."])
    expect(docs.listDocs()).toEqual([])
  })

  test("a barrel loses a tie to any other module", () => {
    const docs = createOntologyDocsCatalog({
      objectTypes: [objectType("Invoice")],
      docs: {
        modules: [
          { path: "billing/index.ts", objectTypeIds: ["Invoice"] },
          { path: "billing/records.ts", objectTypeIds: ["Invoice"] },
        ],
        docs: [{ path: "billing/index.md", contents: "Barrel notes." }],
        scripts: [],
      },
    })
    expect(docs.docPathFor("Invoice")).toBe("billing/records.md")
    // The barrel's notes still belong to the type it exports.
    expect(docs.notesFor("Invoice").map((note) => note.contents)).toEqual(["Barrel notes."])
  })

  test("a multi-type module's notes reach only readers who see one of its types", () => {
    const catalog = createOntologyDocsCatalog({
      objectTypes: [objectType("Salary"), objectType("Review")],
      docs: {
        modules: [{ path: "hr.ts", objectTypeIds: ["Salary", "Review"] }],
        docs: [{ path: "hr.md", contents: "HR records are confidential." }],
        scripts: [],
      },
    })
    const render = (visible: readonly ObjectType[]) =>
      renderOntologyDocs({
        catalog,
        objectTypes: visible,
        valueTypesById: new Map(),
        actionsFor: () => [],
      }).files.filter((file) => String(file.contents).includes("HR records"))

    expect(catalog.listDocs()).toEqual([])
    expect(render([])).toEqual([])
    expect(render([objectType("Review")]).map((file) => file.path)).toEqual(["hr/Review.md"])
  })
})

function objectType(id: string): ObjectType {
  return { id, name: id, properties: [], links: [] }
}

describe("isAgentContextPath", () => {
  test("covers every file the Agent reads", () => {
    expect(isAgentContextPath("SIXB.md")).toBe(true)
    expect(isAgentContextPath("skills/acme-style/SKILL.md")).toBe(true)
    expect(isAgentContextPath("skills/acme-style/scripts/extract.py")).toBe(true)
    expect(isAgentContextPath("skills/acme-style/.env")).toBe(false)
    expect(isAgentContextPath("skills/acme-style/node_modules/x/index.js")).toBe(false)
    expect(isAgentContextPath("ontology/billing/invoice.md")).toBe(true)
    expect(isAgentContextPath("ontology/billing/scripts/export.py")).toBe(true)
    expect(isAgentContextPath("docs/SIXB.md")).toBe(false)
    expect(isAgentContextPath("README.md")).toBe(false)
    expect(isAgentContextPath("ontology/billing/notes.txt")).toBe(false)
    expect(isAgentContextPath("scripts/seed.ts")).toBe(false)
  })
})
