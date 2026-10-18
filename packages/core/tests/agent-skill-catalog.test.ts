import { describe, expect, test } from "bun:test"
import { type AgentSkillDefinition, createAgentSkillCatalog } from "../src/agents/skills"

const skill = (name: string): AgentSkillDefinition => ({ name, description: "A skill.", files: [] })

describe("the Agent Skill catalog", () => {
  test("refuses the 'sixb-' prefix, as discovery does, so no skill can shadow a built-in", () => {
    // Reproduce by dropping the prefix check in createAgentSkillCatalog: a project skill named
    // `sixb-artifacts` then collides with the worker's built-in one only when a run starts.
    expect(() => createAgentSkillCatalog([skill("sixb-artifacts")])).toThrow(
      "uses the reserved 'sixb-' prefix"
    )
    expect(createAgentSkillCatalog([skill("quarterly-review")]).list()).toHaveLength(1)
  })
})
