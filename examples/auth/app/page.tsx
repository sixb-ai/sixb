import { getAuthSessionOptions, listObjectsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"

const notesQueryOptions = listObjectsOptions({
  query: { objectTypeId: "note", order: "asc", limit: "20" },
})

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback
}

export default function AuthExampleApp() {
  const sessionQuery = useQuery(getAuthSessionOptions())
  const notesQuery = useQuery(notesQueryOptions)
  const session = sessionQuery.data?.authenticated ? sessionQuery.data : null
  const notes = notesQuery.data ?? []

  return (
    <main className="auth-app-shell">
      <header className="auth-app-header">
        <div>
          <p className="auth-app-eyebrow">Sixb auth example</p>
          <h1>Custom app</h1>
          <p className="auth-app-lede">
            This page uses the app audience, so it is a simple target for testing direct invitations
            and application grants.
          </p>
        </div>
        <span className="auth-app-status">
          <span /> App session active
        </span>
      </header>

      <section className="auth-app-grid">
        <article className="auth-app-card">
          <p className="auth-app-label">Signed in as</p>
          <h2>{session?.user.displayName ?? session?.user.email ?? "Loading…"}</h2>
          {session?.user.displayName ? (
            <p className="auth-app-muted">{session.user.email}</p>
          ) : null}

          <div className="auth-app-groups">
            {session?.user.groupIds.length ? (
              session.user.groupIds.map((groupId) => <span key={groupId}>{groupId}</span>)
            ) : (
              <span>No groups</span>
            )}
          </div>
        </article>

        <article className="auth-app-card">
          <div className="auth-app-card-heading">
            <div>
              <p className="auth-app-label">Granted data</p>
              <h2>Notes</h2>
            </div>
            <strong>{notes.length}</strong>
          </div>

          {notesQuery.isLoading ? (
            <p className="auth-app-muted">Loading notes…</p>
          ) : notesQuery.isError ? (
            <p className="auth-app-error">Notes are not available to this account.</p>
          ) : notes.length === 0 ? (
            <p className="auth-app-muted">No notes yet.</p>
          ) : (
            <ul className="auth-app-notes">
              {notes.map((note) => (
                <li key={note.id}>
                  <strong>{text(note.properties.title, note.id)}</strong>
                  <p>{text(note.properties.body, "No body")}</p>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <p className="auth-app-help">
        In Atlas, invite a member to <strong>Custom app</strong> and assign the
        <strong> team-members</strong> group. The invitation should return here with an app session.
      </p>
    </main>
  )
}
