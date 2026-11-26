import { randomUUID } from "node:crypto"
import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { CliError, EXIT_API, fail, writeJson, writeRequestResult, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, idSegment, parseQueryOptions, readJson } from "./shared"

/**
 * How long `actions request` waits for the run it requested. An agent's command is killed after 30
 * seconds, which is also how long an Action has to reach its boundary: stopping first leaves the
 * agent with the run id, instead of a dead command and a request it can only repeat.
 */
const ACTION_REQUEST_WAIT_MS = 25_000

export async function actions(
  api: ApiClient,
  args: readonly string[],
  /** Test-only override of {@link ACTION_REQUEST_WAIT_MS}. */
  requestWaitMs = ACTION_REQUEST_WAIT_MS
): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.actions)
  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "actions get", 1)
    return writeJson(await api.get(`/api/actions/${idSegment(positionals[0])}`))
  }
  if (sub === "list") {
    const options = parseQueryOptions(rest, { "--type": "objectTypeId" }, "actions list")
    const response = await api.get("/api/actions")
    if (!options.objectTypeId) return writeJson(response)
    if (!Array.isArray(response)) fail("The actions API returned an invalid response.")
    return writeJson(
      response.filter((value) => asRecord(value).objectTypeId === options.objectTypeId)
    )
  }
  if (sub === "request") {
    const { positionals, options } = parseCommandArgs(
      rest,
      {
        "--subject-type": "string",
        "--subject-id": "string",
        "--file": "string",
        "--run-id": "string",
      },
      "actions request",
      1
    )
    const actionId = positionals[0] ?? ""
    const subjectType = options["--subject-type"]
    const subjectId = options["--subject-id"]
    const paramsSource = options["--file"]
    const runId = options["--run-id"]
    if (Boolean(subjectType) !== Boolean(subjectId)) {
      fail("--subject-type and --subject-id must be provided together.")
    }
    const params = paramsSource ? await readJson(paramsSource) : {}
    if (Array.isArray(params) || typeof params !== "object" || params === null) {
      fail("Action params must be a JSON object.")
    }
    // The API answers once the Action has run, with its terminal run. Every request names its run,
    // so that one this command stops waiting for can still be read: the run is not cancelled.
    const requestedRunId = runId ?? `act_${randomUUID()}`
    const waiting = AbortSignal.timeout(requestWaitMs)
    try {
      return writeRequestResult(
        await api.post(
          `/api/actions/${idSegment(actionId)}`,
          {
            params,
            ...(subjectType && subjectId
              ? { subject: { kind: "object", objectTypeId: subjectType, primaryId: subjectId } }
              : {}),
            runId: requestedRunId,
          },
          { signal: waiting }
        )
      )
    } catch (error) {
      if (!waiting.aborted) throw error
      throw new CliError(
        {
          code: "action_wait_timeout",
          message:
            `Action run '${requestedRunId}' did not finish within ${requestWaitMs / 1_000} ` +
            "seconds. It was not cancelled.",
          hint:
            `Read it with 'sixb action-runs get ${requestedRunId}': its record exists once it ` +
            `has ended. A repeated request must pass '--run-id ${requestedRunId}', or the ` +
            "Action runs twice.",
        },
        EXIT_API
      )
    }
  }
  fail(`Unknown actions command '${sub}'.`)
}
