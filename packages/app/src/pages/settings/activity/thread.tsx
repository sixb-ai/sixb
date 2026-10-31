import { getObservedAgentThreadOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { Bot } from "lucide-react"
import { useCallback, useMemo } from "react"
import { useLocation, useParams, useSearchParams } from "react-router-dom"
import { ThreadArtifactsMenu } from "../../../agent/components/thread-artifacts-menu"
import {
  ObservedConversation,
  observedThreadPollMs,
  useObservedAuthors,
} from "../../../agent/observed-conversation"
import {
  type ArtifactTarget,
  artifactTargetFromSearch,
  withArtifactTarget,
} from "../../../artifacts/target"
import { SectionPage, SectionWorkspace, WorkspaceHeader } from "../../section-page"
import {
  IconTile,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelSkeleton,
  Pill,
  useLoadFailure,
  useNumbers,
} from "../../section-ui"
import { useActivityMessages } from "./messages"

const ACTIVITY_HREF = "/settings/activity"

/**
 * Settings › Activity › a conversation: someone else's thread with the Agent, read-only, with
 * `can.observe(agent.threads)`. It never joins the reader's own threads.
 */
export function SettingsActivityThreadPage() {
  const messages = useActivityMessages()
  const { count } = useNumbers()
  const threadId = useParams().threadId ?? ""
  const location = useLocation()
  const back = { href: backHref(location.state), label: messages.title }

  const threadQuery = useQuery({
    ...getObservedAgentThreadOptions({ path: { threadId } }),
    retry: false,
    refetchInterval: (query) =>
      observedThreadPollMs(query.state.status, query.state.data?.activeRunId),
  })
  const thread = threadQuery.data
  const authors = useObservedAuthors(threadId)
  const failure = useLoadFailure(threadQuery.error, {
    id: threadId,
    denied: messages.thread.denied,
  })

  // The open artifact lives in `?artifact=&v=&part=`, as on the agent's own page. Opening one keeps
  // the state that leads back to the visit.
  const [searchParams, setSearchParams] = useSearchParams()
  const searchKey = searchParams.toString()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the parameters.
  const artifactTarget = useMemo(() => artifactTargetFromSearch(searchParams), [searchKey])
  const onArtifactTargetChange = useCallback(
    (target: ArtifactTarget | null) => {
      setSearchParams((current) => withArtifactTarget(current, target), {
        replace: target === null,
        state: location.state,
      })
    },
    [setSearchParams, location.state]
  )

  if (!thread || threadQuery.isError) {
    return (
      <SectionPage
        section="settings"
        page="activity"
        back={back}
        title={threadQuery.error ? failure.title : messages.thread.untitled}
      >
        <Panel>
          {threadQuery.error ? (
            <PanelEmpty
              tone="error"
              icon={Bot}
              title={failure.title}
              description={failure.description}
            />
          ) : (
            <PanelSkeleton rows={2} />
          )}
        </Panel>
      </SectionPage>
    )
  }

  const owner = thread.ownerPrincipal
  const ownerName = authors.get(`${owner.type}:${owner.id}`) ?? owner.id

  return (
    <SectionWorkspace section="settings" page="activity">
      <WorkspaceHeader
        back={back}
        icon={<IconTile icon={Bot} />}
        title={thread.title?.trim() || messages.thread.untitled}
        meta={
          <>
            <span className="truncate">{messages.thread.by(ownerName)}</span>
            <MetaDot />
            <span className="shrink-0">
              {messages.visit.messages(thread.messageCount, count(thread.messageCount))}
            </span>
          </>
        }
        actions={
          <>
            {/* The conversation's artifacts, which an observer reads too. */}
            <ThreadArtifactsMenu
              threadId={thread.id}
              onOpen={onArtifactTargetChange}
              withGallery={false}
            />

            {/* On a phone the title needs the room; the notice under the conversation says it too. */}
            <span className="max-sm:hidden">
              <Pill tone="muted">{messages.thread.readOnly}</Pill>
            </span>
          </>
        }
      />
      {/* The workspace's height is a minimum, which a chat's scroller cannot fill by percentage. */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <ObservedConversation
            thread={thread}
            artifactTarget={artifactTarget}
            onArtifactTargetChange={onArtifactTargetChange}
          />
        </div>
      </div>
    </SectionWorkspace>
  )
}

/** Back to the activity view the reader came from, with its period, user and visit. */
function backHref(state: unknown): string {
  const from =
    typeof state === "object" && state !== null && "from" in state ? state.from : undefined

  return typeof from === "string" && from.startsWith(ACTIVITY_HREF) ? from : ACTIVITY_HREF
}
