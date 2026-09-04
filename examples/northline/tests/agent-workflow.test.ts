import { describe, expect, test } from "bun:test"
import { languageModels } from "../ai/models"
import { lookupResponsePolicy } from "../ai/tools"
import {
  agentServiceAssessmentWorkflow,
  assessServiceCase,
} from "../workflows/agent-service-assessment"

describe("Northline agent workflow", () => {
  test("provides a manually runnable agent node with a policy tool and structured output", () => {
    expect(languageModels.map((model) => model.modelId)).toEqual([
      "deepseek/deepseek-v4-flash-vision-exp",
      "openai/gpt-5.6-luna",
      "anthropic/claude-haiku-4.5",
    ])
    expect(assessServiceCase.toolNames).toContain(lookupResponsePolicy.name)
    expect(agentServiceAssessmentWorkflow.triggers).toEqual([])
    expect(agentServiceAssessmentWorkflow.nodes).toHaveLength(1)
    expect(agentServiceAssessmentWorkflow.nodes[0]).toMatchObject({
      type: "agent",
      id: "assess-service-case",
      key: "assessServiceCase",
      agentStep: assessServiceCase,
    })
    expect(assessServiceCase.output).toEqual({
      priority: {
        type: "enum",
        valueType: "string",
        values: ["routine", "urgent", "emergency"],
      },
      responseWindowMinutes: "integer",
      dispatchRecommended: "boolean",
      rationale: "string",
    })
  })

  test("builds an explicit prompt that requires a visible tool call", () => {
    const prompt = assessServiceCase.prompt({
      input: {
        caseNumber: "SC-1042",
        alarmSeverity: "high",
        contractTier: "priority-24-7",
        summary: "RTU-7 supply fan VFD failed while the building is occupied.",
      },
    })

    expect(prompt).toContain("SC-1042")
    expect(prompt).toContain("lookup_response_policy")
    expect(prompt).toContain("priority-24-7")
  })
})
