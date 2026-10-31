import {
  type AgentRunSession,
  claimAgentRun,
  claimAgentRunForRunner,
  createAgentRunToken,
  createHttpAgentRunSession,
  serveAgentRunSession,
} from "../src/agents"
import type { AgentRunRecord } from "../src/storage/agents"
import {
  type ClaimAgentRunSession,
  describeAgentRunSessionContract,
} from "./agent-run-session-contract"

// The session suite, run on a session a runner reaches over HTTP: claimed as a runner claims, each
// operation one request to the server's handler, with no network between them.

const claimOverHttp: ClaimAgentRunSession = async (host, input) => {
  const claimed =
    input.run.status === "running"
      ? await takeOver(host, input)
      : await claimAgentRunForRunner(host, input)
  if (!claimed) return null
  return createHttpAgentRunSession({
    apiUrl: "http://sixb.test",
    runToken: claimed.runToken,
    run: claimed.run,
    fetch: async (request) =>
      (await serveAgentRunSession(host, request)) ?? new Response(null, { status: 404 }),
  }) as AgentRunSession<typeof input.run & AgentRunRecord> as never
}

/**
 * A runner over HTTP claims only a queued run, so the suite takes a running one over in process,
 * as the lapsed-run sweep does. The sessions it fences are still reached over HTTP.
 */
async function takeOver(...args: Parameters<ClaimAgentRunSession>) {
  const [host] = args
  const session = await claimAgentRun(...args)
  if (!session) return null
  await session.close()
  const { run, executionToken } = session
  return {
    run,
    runToken: createAgentRunToken({ projectId: host.projectId, runId: run.id, executionToken }),
  }
}

describeAgentRunSessionContract(claimOverHttp)
