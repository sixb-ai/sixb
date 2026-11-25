import type { Broker } from "../broker"
import type { SixbErrorCode } from "../errors/types"
import type { ClaimedQueueJob, Queue, QueueJob, Queues } from "../queues"

/**
 * Providers take the project id with every call, and key streams and lanes by it. A branch's
 * runtime keeps its project id for storage and events, and hands its providers `transportId`
 * instead, so its streams and lanes are its own on a broker or a Redis that production, plain
 * `sixb dev` or another branch also uses.
 */
export function namespaceBroker(broker: Broker, transportId: string): Broker {
  return {
    scope: broker.scope,
    ensureStream: (params) => broker.ensureStream({ ...params, projectId: transportId }),
    append: (params) => broker.append({ ...params, projectId: transportId }),
    read: (params) => broker.read({ ...params, projectId: transportId }),
    tail: (params) => broker.tail({ ...params, projectId: transportId }),
    latestCursor: (params) => broker.latestCursor({ ...params, projectId: transportId }),
    subscribe: (params, handler) =>
      broker.subscribe({ ...params, projectId: transportId }, handler),
    ...(broker.close === undefined ? {} : { close: () => broker.close?.() }),
  }
}

/**
 * The queues with every lane keyed by `transportId`. A job a provider hands back carries the id it
 * was keyed by, so its `projectId` is turned back into the project's before anything reads it.
 */
export function namespaceQueues(queues: Queues, projectId: string, transportId: string): Queues {
  const lane = <TJob extends QueueJob, TCode extends SixbErrorCode>(queue: Queue<TJob, TCode>) =>
    namespaceQueue(queue, projectId, transportId)

  return {
    vectorIndexing: lane(queues.vectorIndexing),
    lake: lane(queues.lake),
    renders: lane(queues.renders),
    syncRuns: lane(queues.syncRuns),
    pipelines: lane(queues.pipelines),
    projections: lane(queues.projections),
    workflows: lane(queues.workflows),
    agents: lane(queues.agents),
    scope: queues.scope,
    health: () => queues.health(),
    ...(queues.close === undefined ? {} : { close: () => queues.close?.() }),
  }
}

function namespaceQueue<TJob extends QueueJob, TCode extends SixbErrorCode>(
  queue: Queue<TJob, TCode>,
  projectId: string,
  transportId: string
): Queue<TJob, TCode> {
  const own = (job: TJob): TJob => ({ ...job, projectId })
  const ownClaim = (claim: ClaimedQueueJob<TJob>): ClaimedQueueJob<TJob> => ({
    ...claim,
    job: own(claim.job),
  })
  const renewLease = queue.renewLease?.bind(queue)

  return {
    enqueue: async (params) =>
      (await queue.enqueue({ ...params, projectId: transportId })).map(own),
    claim: async (params) =>
      (await queue.claim({ ...params, projectId: transportId })).map(ownClaim),
    complete: (params) => queue.complete({ ...params, projectId: transportId }),
    retry: (params) => queue.retry({ ...params, projectId: transportId }),
    fail: (params) => queue.fail({ ...params, projectId: transportId }),
    ...(renewLease === undefined
      ? {}
      : {
          renewLease: async (params) => {
            const renewed = await renewLease({ ...params, projectId: transportId })
            return renewed === null ? null : ownClaim(renewed)
          },
        }),
  }
}
