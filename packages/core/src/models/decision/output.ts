import type { SchemaOrRef } from "../../ontology/refs"
import type {
  ChoiceQuestion,
  DecisionContent,
  DecisionQuestion,
  DecisionQuestions,
  ScoreQuestion,
} from "./types"
import { assertDecisionQuestions } from "./validation"

type RequiredField<S extends SchemaOrRef> = { required: true; schema: S }
type ChoiceAnswerSchema<C extends Readonly<Record<string, DecisionContent | null>>> = {
  type: "object"
  properties: {
    choice: RequiredField<{ type: "enum"; valueType: "string"; values: Extract<keyof C, string>[] }>
    probabilities: RequiredField<{
      type: "object"
      properties: { [K in keyof C]: RequiredField<"double"> }
    }>
    confidence: { schema: "double" }
  }
}
export type DecisionAnswerSchema<Q extends DecisionQuestion> =
  Q extends ChoiceQuestion<infer C>
    ? ChoiceAnswerSchema<C>
    : Q extends ScoreQuestion
      ? {
          type: "object"
          properties: {
            score: RequiredField<"double">
            probabilities: RequiredField<{ type: "array"; items: "double" }>
            confidence: { schema: "double" }
          }
        }
      : { type: "object"; properties: { probability: RequiredField<"double"> } }
export type DecisionOutputShape<Q extends DecisionQuestions> = {
  -readonly [K in keyof Q]: DecisionAnswerSchema<Q[K]>
}

/** Ordinary Sixb output schemas for actions/workflow steps; evaluate() validates distributions. */
export function decisionOutput<const Q extends DecisionQuestions>(
  questions: Q
): DecisionOutputShape<Q> {
  assertDecisionQuestions(questions)
  const result: Record<string, SchemaOrRef> = Object.fromEntries(
    Object.entries(questions).map(([key, q]) => {
      if (q.type === "probability")
        return [
          key,
          {
            type: "object",
            properties: { probability: { required: true, schema: "double" } },
          },
        ]
      const confidence = { schema: "double" as const }
      if (q.type === "score")
        return [
          key,
          {
            type: "object",
            properties: {
              score: { required: true, schema: "double" },
              probabilities: { required: true, schema: { type: "array", items: "double" } },
              confidence,
            },
          },
        ]
      return [
        key,
        {
          type: "object",
          properties: {
            choice: {
              required: true,
              schema: { type: "enum", valueType: "string", values: Object.keys(q.options) },
            },
            probabilities: {
              required: true,
              schema: {
                type: "object",
                properties: Object.fromEntries(
                  Object.keys(q.options).map((option) => [
                    option,
                    { required: true, schema: "double" },
                  ])
                ),
              },
            },
            confidence,
          },
        },
      ]
    })
  )
  // Each branch builds the corresponding schema while retaining literal option keys in the type.
  return result as DecisionOutputShape<Q>
}
