import { defineIntervention } from "@sixb/core"

export const reviewReport = defineIntervention("review-report")
  .input({ report: "string" })
  .response({ report: "string" })
  .defaults(({ input }) => ({ report: input.report }))
