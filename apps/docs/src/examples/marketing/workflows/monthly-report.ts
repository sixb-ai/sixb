import { defineWorkflow } from "@sixb/core"
import { analyzePerformanceWithAgent } from "./steps/analyze-performance"
import { reviewReport } from "./steps/review-report"

export const monthlyReport = defineWorkflow("monthly-report")
  .input({ month: "string", performance: "string" })
  .then(analyzePerformanceWithAgent)
  .then(reviewReport)
