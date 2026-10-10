import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createSixb, defineObjectType, prop } from "../src"
import { isAgentContextPath } from "../src/bootstrap"
import { createTestRuntimeDeps } from "./test-runtime-deps"

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

describe("isAgentContextPath", () => {
  test("covers every file the Agent reads", () => {
    expect(isAgentContextPath("SIXB.md")).toBe(true)
    expect(isAgentContextPath("skills/acme-style/SKILL.md")).toBe(true)
    expect(isAgentContextPath("skills/acme-style/scripts/extract.py")).toBe(true)
    expect(isAgentContextPath("skills/acme-style/.env")).toBe(false)
    expect(isAgentContextPath("skills/acme-style/node_modules/x/index.js")).toBe(false)
    expect(isAgentContextPath("docs/SIXB.md")).toBe(false)
    expect(isAgentContextPath("README.md")).toBe(false)
  })
})
