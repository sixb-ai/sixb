import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadAgentSkills } from "../src/agent-skills"
import { writeProjectSkill } from "./helpers"

async function createProjectRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `sixb-agent-skills-${label}-`))
}

describe("Agent Skills", () => {
  test("discovers packaged built-ins and tolerates a missing project skills directory", async () => {
    const projectRoot = await createProjectRoot("missing")
    try {
      const skills = await loadAgentSkills({ projectSkillsDir: join(projectRoot, "skills") })
      expect(skills.map((skill) => skill.name)).toEqual([
        "sixb-actions",
        "sixb-query",
        "sixb-telemetry",
      ])
      for (const skill of skills) {
        const skillFile = skill.files.find((file) => file.relativePath === "SKILL.md")
        expect(skillFile?.contents).toContain(`name: ${skill.name}`)
        expect(skill.description.length).toBeGreaterThan(0)
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("parses YAML metadata and recursively preserves binary files and executable modes", async () => {
    const projectRoot = await createProjectRoot("files")
    try {
      await writeProjectSkill(
        projectRoot,
        "acme-style",
        [
          "---",
          'name: "acme-style"',
          "description: >",
          "  Use when drafting Acme customer-facing",
          "  messages.",
          "compatibility: Ignored but preserved in SKILL.md.",
          "---",
          "",
          "# Acme Style",
        ].join("\n"),
        {
          "assets/template.bin": new Uint8Array([0, 127, 255]),
          "scripts/validate.sh": "#!/bin/sh\nexit 0\n",
        }
      )
      await chmod(join(projectRoot, "skills", "acme-style", "scripts", "validate.sh"), 0o755)

      const skills = await loadAgentSkills({ projectSkillsDir: join(projectRoot, "skills") })
      const skill = skills.find((candidate) => candidate.name === "acme-style")
      expect(skill?.description).toBe("Use when drafting Acme customer-facing messages.")
      expect(
        skill?.files.find((file) => file.relativePath === "assets/template.bin")?.contents
      ).toEqual(new Uint8Array([0, 127, 255]))
      expect(skill?.files.find((file) => file.relativePath === "scripts/validate.sh")?.mode).toBe(
        0o755
      )
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("rejects invalid project skill frontmatter", async () => {
    const projectRoot = await createProjectRoot("invalid")
    try {
      await writeProjectSkill(
        projectRoot,
        "acme-style",
        ["---", "name: acme-style", "---", "", "# Acme Style"].join("\n")
      )
      await expect(
        loadAgentSkills({ projectSkillsDir: join(projectRoot, "skills") })
      ).rejects.toThrow("[SixbAgentWorker] Agent skill")
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("rejects built-in collisions and the reserved project prefix", async () => {
    const collisionRoot = await createProjectRoot("collision")
    const reservedRoot = await createProjectRoot("reserved")
    try {
      await writeProjectSkill(
        collisionRoot,
        "sixb-query",
        [
          "---",
          "name: sixb-query",
          "description: Invalid attempt to replace a built-in skill.",
          "---",
        ].join("\n")
      )
      await expect(
        loadAgentSkills({ projectSkillsDir: join(collisionRoot, "skills") })
      ).rejects.toThrow("collides with a built-in agent skill")

      await writeProjectSkill(
        reservedRoot,
        "sixb-custom",
        [
          "---",
          "name: sixb-custom",
          "description: Invalid use of the reserved prefix.",
          "---",
        ].join("\n")
      )
      await expect(
        loadAgentSkills({ projectSkillsDir: join(reservedRoot, "skills") })
      ).rejects.toThrow("uses the reserved 'sixb-' prefix")
    } finally {
      await Promise.all([
        rm(collisionRoot, { recursive: true, force: true }),
        rm(reservedRoot, { recursive: true, force: true }),
      ])
    }
  })

  test("rejects symlinks instead of copying their targets", async () => {
    const projectRoot = await createProjectRoot("symlink")
    try {
      await writeProjectSkill(
        projectRoot,
        "acme-style",
        [
          "---",
          "name: acme-style",
          "description: Use when drafting Acme customer-facing messages.",
          "---",
        ].join("\n")
      )
      const target = join(projectRoot, "target.md")
      await writeFile(target, "secret")
      await symlink(target, join(projectRoot, "skills", "acme-style", "leak.md"))

      await expect(
        loadAgentSkills({ projectSkillsDir: join(projectRoot, "skills") })
      ).rejects.toThrow("must not be a symlink")
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
