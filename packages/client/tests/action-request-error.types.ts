import type { ExecuteActionResult, ExecuteGlobalActionResult } from "../src/models"

type ActionResultData = ExecuteActionResult["data"]
type GlobalActionResultData = ExecuteGlobalActionResult["data"]
type ActionSuccess = Extract<ActionResultData, { readonly success: true }>
type ActionError = Extract<ActionResultData, { readonly success: false }>

const success: ActionSuccess = { success: true, runId: "act_1" }
const error: ActionError = {
  success: false,
  error: {
    message: "Request rejected",
    code: "dataset.not_found",
    status: 404,
  },
}
const globalResult: GlobalActionResultData = error

// @ts-expect-error successful requests always expose the created durable run id
const missingRunId: ActionSuccess = { success: true }
// @ts-expect-error request errors are structured values, never bare strings
const bareError: ActionError = { success: false, error: "Request rejected" }

void [success, error, globalResult, missingRunId, bareError]
