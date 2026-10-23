import { PersonAvatar } from "../../artifacts/person-avatar"
import type { ThreadSharing } from "../hooks/use-thread-sharing"
import { useAgentMessages } from "../i18n"
import { ContinueButton } from "./thread-people"

/**
 * Above a participant's composer: whose conversation this is, and the way to continue alone. One
 * line wherever it fits; a long name gives way, never the action.
 */
export function SharedThreadNotice({
  owner,
  sharing,
}: {
  readonly owner: string
  readonly sharing: ThreadSharing
}) {
  const messages = useAgentMessages().sharing

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-5 pt-1 text-xs text-muted-foreground">
      <PersonAvatar name={owner} size="xs" />
      <span className="min-w-0 truncate">{messages.sharedBy(owner)}</span>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <ContinueButton
        label={messages.continueMine}
        sharing={sharing}
        variant="link"
        className="shrink-0"
      />
    </div>
  )
}
