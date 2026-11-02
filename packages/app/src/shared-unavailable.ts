/**
 * What `app/shared-unavailable.tsx` receives when a shared link is invalid, expired, or revoked.
 *
 * The screen renders without a session, a router or the data client: the link opened nothing, so
 * there is nothing of the project to read. `title` and `description` are Sixb's own text, in the
 * reader's language, for a screen that keeps them.
 */
export interface SharedUnavailableProps {
  /** The reader's language, negotiated from the browser: `"en"` or `"fr"`. */
  readonly locale: string
  readonly title: string
  readonly description: string
}
