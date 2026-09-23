import type { ChoiceQuestion, DecisionContent, ProbabilityQuestion, ScoreQuestion } from "./types"
import { assertDecisionQuestions } from "./validation"

/** Plain serializable descriptors; no registration or inference takes place here. */
export const question = {
  choice<const TOptions extends Readonly<Record<string, DecisionContent | null>>>(input: {
    readonly instructions: DecisionContent
    readonly options: TOptions
  }): ChoiceQuestion<TOptions> {
    const result = { ...input, type: "choice" as const }
    assertDecisionQuestions({ question: result })
    return result
  },
  score<
    const TLevels extends readonly [DecisionContent, DecisionContent, ...DecisionContent[]],
  >(input: {
    readonly instructions: DecisionContent
    readonly levels: TLevels
  }): ScoreQuestion<TLevels> {
    const result = { ...input, type: "score" as const }
    assertDecisionQuestions({ question: result })
    return result
  },
  probability(instructions: DecisionContent): ProbabilityQuestion {
    const result = { type: "probability" as const, instructions }
    assertDecisionQuestions({ question: result })
    return result
  },
}
