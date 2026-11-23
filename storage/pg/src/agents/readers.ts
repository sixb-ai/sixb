import type { Principal } from "@sixb/core"
import type { PgStoreClient } from "../transactions"

/**
 * The conversations `reader` owns or takes part in, as a subquery of `thread_id`s: what a list
 * restricted to one reader joins, found from their side through the owner's and the participant's
 * indexes, so its cost is theirs, not the project's.
 */
export function readerConversations(sql: PgStoreClient, projectId: string, reader: Principal) {
  return sql`
    SELECT id AS thread_id FROM agent_threads
    WHERE project_id = ${projectId}
      AND kind = 'conversation'
      AND owner_principal_type = ${reader.type}
      AND owner_principal_id = ${reader.id}
    UNION
    SELECT thread_id FROM agent_thread_participants
    WHERE project_id = ${projectId}
      AND principal_type = ${reader.type}
      AND principal_id = ${reader.id}
  `
}
