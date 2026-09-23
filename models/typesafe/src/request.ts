import type { DecisionQuestion, DecisionQuestions } from "@sixb/core/models"

/** Keep user-selected keys as data, including __proto__ and constructor. */
export function typesafeQuestions(questions: DecisionQuestions) {
  return Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [key, typesafeQuestion(question)])
  )
}

function typesafeQuestion(question: DecisionQuestion) {
  const { instructions } = question
  switch (question.type) {
    case "choice":
      return { type: "choice", instructions, criteria: question.options }
    case "score":
      return { type: "score", instructions, criteria: question.levels }
    case "probability":
      return { type: "noul", instructions }
  }
}
