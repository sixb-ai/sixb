/**
 * The conversations a reader owns or takes part in, as a subquery of `thread_id`s: what a list
 * restricted to one reader joins, found from their side through the owner's and the participant's
 * indexes, so its cost is theirs, not the project's. It reads the project as `?1`, and the reader's
 * type and id as `?3` and `?4`.
 */
export const READER_CONVERSATIONS = `
  SELECT id AS thread_id FROM agent_threads
  WHERE project_id = ?1
    AND kind = 'conversation'
    AND owner_principal_type = ?3
    AND owner_principal_id = ?4
  UNION
  SELECT thread_id FROM agent_thread_participants
  WHERE project_id = ?1
    AND principal_type = ?3
    AND principal_id = ?4
`
