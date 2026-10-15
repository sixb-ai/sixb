import { client } from "@sixb/client"
import {
  getConnectorOptions,
  listConnectorsOptions,
  listSyncsOptions,
  listWebhookRunsOptions,
} from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { Cable, ChevronRight, RefreshCw, Webhook } from "lucide-react"
import { useParams } from "react-router-dom"
import { DetailFallback, SectionPage } from "../section-page"
import {
  apiErrorMessage,
  CopyButton,
  FailureSummary,
  formatDuration,
  humanize,
  IconTile,
  isUnrecorded,
  MetaDot,
  PageSection,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  RunStatusPill,
  UnrecordedHistory,
  useFormat,
  useNumbers,
} from "../section-ui"
import { useDataMessages } from "./messages"
import { ConnectorIcon } from "./shared"

/** Data › Connectors: the services this project reads from. */
export function DataConnectorsPage() {
  const messages = useDataMessages()
  const connectorsQuery = useQuery({ ...listConnectorsOptions(), retry: false })
  const connectors = connectorsQuery.data ?? []

  return (
    <SectionPage
      section="data"
      page="connectors"
      title={messages.connectors.title}
      description={messages.connectors.description}
    >
      <Panel>
        {connectorsQuery.isPending ? (
          <PanelSkeleton rows={3} />
        ) : connectorsQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={Cable}
            title={messages.connectors.title}
            description={apiErrorMessage(connectorsQuery.error, messages.common.loadFailed)}
          />
        ) : connectors.length === 0 ? (
          <PanelEmpty
            icon={Cable}
            title={messages.connectors.emptyTitle}
            description={messages.connectors.emptyDescription}
          />
        ) : (
          connectors.map((connector) => (
            <PanelRow
              key={connector.id}
              href={`/data/connectors/${encodeURIComponent(connector.id)}`}
              leading={<ConnectorIcon type={connector.type} />}
              title={<span className="truncate">{humanize(connector.id)}</span>}
              meta={
                <>
                  <span className="font-mono text-xs">{connector.type}</span>
                  <MetaDot />
                  <span>{messages.connectors.syncCount(connector.syncIds.length)}</span>
                  {connector.webhooks.length > 0 ? (
                    <>
                      <MetaDot />
                      <span>{messages.connectors.webhookCount(connector.webhooks.length)}</span>
                    </>
                  ) : null}
                </>
              }
              trailing={<ChevronRight className="size-4 text-muted-foreground/60" />}
            />
          ))
        )}
      </Panel>
    </SectionPage>
  )
}

/** One connector: its syncs, and its webhooks and their deliveries. */
export function DataConnectorPage() {
  const messages = useDataMessages()
  const format = useFormat()
  const numbers = useNumbers()
  const connectorId = useParams().connectorId ?? ""
  const connectorQuery = useQuery({
    ...getConnectorOptions({ path: { connectorId } }),
    retry: false,
  })
  const syncsQuery = useQuery({ ...listSyncsOptions(), retry: false })
  const connector = connectorQuery.data
  const webhooks = connector?.webhooks ?? []
  const runsQuery = useQuery({
    ...listWebhookRunsOptions({ query: { connectorId, limit: "20", order: "desc" } }),
    retry: false,
    enabled: webhooks.length > 0,
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === "running") ? 3000 : false,
  })
  const syncs = (syncsQuery.data ?? []).filter((sync) => sync.connector.id === connectorId)
  const apiUrl = (client.getConfig().baseUrl ?? window.location.origin).replace(/\/$/, "")
  const back = { href: "/data/connectors", label: messages.connectors.title }

  if (!connector) {
    return (
      <DetailFallback
        section="data"
        page="connectors"
        back={back}
        name={humanize(connectorId)}
        id={connectorId}
        icon={Cable}
        error={connectorQuery.error}
      />
    )
  }

  return (
    <SectionPage
      section="data"
      page="connectors"
      back={back}
      icon={<ConnectorIcon type={connector.type} size="lg" />}
      title={humanize(connector.id)}
      meta={
        <>
          <span className="font-mono text-xs">{connector.type}</span>
          {connector.connection ? (
            <>
              <MetaDot />
              <span>{messages.connectors.oauth}</span>
            </>
          ) : null}
        </>
      }
    >
      <PageSection
        title={messages.connectors.syncsTitle}
        description={messages.connectors.syncsDescription}
      >
        <Panel>
          {syncsQuery.isPending ? (
            <PanelSkeleton rows={2} />
          ) : syncsQuery.isError ? (
            <PanelEmpty
              tone="error"
              icon={RefreshCw}
              title={messages.connectors.syncsTitle}
              description={apiErrorMessage(syncsQuery.error, messages.common.loadFailed)}
            />
          ) : syncs.length === 0 ? (
            <PanelEmpty
              icon={RefreshCw}
              title={messages.connectors.noSyncsTitle}
              description={messages.connectors.noSyncsDescription}
            />
          ) : (
            syncs.map((sync) => (
              <PanelRow
                key={sync.id}
                href={`/data/syncs/${encodeURIComponent(sync.id)}`}
                leading={<IconTile icon={RefreshCw} />}
                title={<span className="truncate">{humanize(sync.id)}</span>}
                meta={
                  <>
                    <span>{messages.common.writes(sync.target.dataset.id)}</span>
                    {sync.latestRun ? (
                      <>
                        <MetaDot />
                        <span>
                          {format.relative(sync.latestRun.startedAt ?? sync.latestRun.queuedAt)}
                        </span>
                      </>
                    ) : null}
                  </>
                }
                trailing={
                  sync.latestRun ? (
                    <RunStatusPill status={sync.latestRun.status} />
                  ) : (
                    <Pill tone="muted">{messages.common.neverRun}</Pill>
                  )
                }
              />
            ))
          )}
        </Panel>
      </PageSection>

      {webhooks.length > 0 ? (
        <>
          <PageSection
            title={messages.connectors.webhooksTitle}
            description={messages.connectors.webhooksDescription}
          >
            <Panel>
              {webhooks.map((webhook) => (
                <PanelRow
                  key={webhook.id}
                  leading={<IconTile icon={Webhook} />}
                  title={
                    <>
                      <span className="truncate">{humanize(webhook.id)}</span>
                      <Pill tone={webhook.hasVerify ? "ok" : "warn"}>
                        {webhook.hasVerify
                          ? messages.connectors.verified
                          : messages.connectors.unverified}
                      </Pill>
                    </>
                  }
                  meta={
                    <>
                      <code className="truncate font-mono text-xs">
                        {webhook.method} {apiUrl}
                        {webhook.route}
                      </code>
                      <MetaDot />
                      <span>{messages.connectors.bodyFormat[webhook.bodyFormat]}</span>
                      {webhook.hasIdempotency ? (
                        <>
                          <MetaDot />
                          <span>{messages.connectors.idempotent}</span>
                        </>
                      ) : null}
                    </>
                  }
                  trailing={<CopyButton value={`${apiUrl}${webhook.route}`} />}
                />
              ))}
            </Panel>
          </PageSection>

          <PageSection
            title={messages.connectors.deliveriesTitle}
            description={messages.connectors.deliveriesDescription}
          >
            <Panel>
              {runsQuery.isPending ? (
                <PanelSkeleton rows={3} />
              ) : runsQuery.isError ? (
                isUnrecorded(runsQuery.error) ? (
                  <UnrecordedHistory what={messages.connectors.deliveryWhat} />
                ) : (
                  <PanelEmpty
                    tone="error"
                    icon={Webhook}
                    title={messages.connectors.deliveriesTitle}
                    description={apiErrorMessage(runsQuery.error, messages.common.loadFailed)}
                  />
                )
              ) : runsQuery.data.runs.length === 0 ? (
                <PanelEmpty
                  icon={Webhook}
                  title={messages.connectors.deliveriesEmptyTitle}
                  description={messages.connectors.deliveriesEmptyDescription}
                />
              ) : (
                runsQuery.data.runs.map((run) => (
                  <PanelRow
                    key={run.id}
                    title={
                      <span className="truncate">
                        {format.dateTime(run.startedAt)}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {humanize(run.webhookId)}
                        </span>
                      </span>
                    }
                    meta={
                      <>
                        {run.responseStatus !== undefined ? (
                          <>
                            <span className="tabular-nums">
                              {messages.connectors.responded(run.responseStatus)}
                            </span>
                            <MetaDot />
                          </>
                        ) : null}
                        <span className="tabular-nums">
                          {messages.connectors.bytes(numbers.bytes(run.requestBodyBytes))}
                        </span>
                        {run.finishedAt ? (
                          <>
                            <MetaDot />
                            <span className="tabular-nums">
                              {formatDuration(run.startedAt, run.finishedAt)}
                            </span>
                          </>
                        ) : null}
                      </>
                    }
                    trailing={<RunStatusPill status={run.status} />}
                  >
                    {run.error ? <FailureSummary failure={run.error} compact /> : null}
                  </PanelRow>
                ))
              )}
            </Panel>
          </PageSection>
        </>
      ) : null}
    </SectionPage>
  )
}
