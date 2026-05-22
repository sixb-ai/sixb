import type { GetConnectorResponse, ListConnectorsResponse } from "@pario/client"
import { getConnectorOptions, listConnectorsOptions } from "@pario/client/hooks"
import {
  Button,
  Card,
  CollectionCardButton,
  CollectionCardGrid,
  CollectionHeader,
  CollectionViewToggle,
  EmptyState,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { Cable, ChevronLeft, GitBranch, Loader2, Search, Webhook } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { humanizeIdentifier } from "../lib/labels"
import { getCollectionViewStyle, setCollectionViewStyle } from "../lib/userPreferences"

type Connector = ListConnectorsResponse[number] | GetConnectorResponse
type ConnectorListViewStyle = "cards" | "table"

const connectorListViewOptions = [
  { value: "cards", label: "Cards" },
  { value: "table", label: "Table" },
] as const

function connectorName(connector: Connector): string {
  return humanizeIdentifier(connector.id)
}

function connectorSummary(connector: Connector): string {
  const parts = [`${connector.type} connector`]
  if (connector.syncIds.length > 0) {
    parts.push(`${connector.syncIds.length} sync${connector.syncIds.length === 1 ? "" : "s"}`)
  }
  if (connector.webhooks.length > 0) {
    parts.push(`${connector.webhooks.length} webhook${connector.webhooks.length === 1 ? "" : "s"}`)
  }
  return parts.join(" · ")
}

function ConnectorListItem({
  connector,
  onSelect,
}: {
  connector: ListConnectorsResponse[number]
  onSelect: () => void
}) {
  return (
    <CollectionCardButton onClick={onSelect}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Cable className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{connectorName(connector)}</p>
          <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {connector.type}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{connector.id}</p>
      </div>
    </CollectionCardButton>
  )
}

function ConnectorTableView({
  connectors,
  onSelect,
}: {
  connectors: ListConnectorsResponse
  onSelect: (connectorId: string) => void
}) {
  return (
    <Card className="overflow-hidden p-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Connector</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Syncs</TableHead>
            <TableHead className="hidden text-right md:table-cell">Webhooks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connectors.map((connector) => (
            <TableRow
              key={connector.id}
              onClick={() => onSelect(connector.id)}
              className="cursor-pointer"
            >
              <TableCell>
                <div className="flex min-w-0 items-center gap-2">
                  <Cable className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {connectorName(connector)}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">{connector.id}</p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {connector.type}
              </TableCell>
              <TableCell className="hidden text-right text-sm text-muted-foreground sm:table-cell">
                {connector.syncIds.length}
              </TableCell>
              <TableCell className="hidden text-right text-sm text-muted-foreground md:table-cell">
                {connector.webhooks.length}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-2.5 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "max-w-[65%] break-words text-right text-sm text-foreground",
          mono && "font-mono text-xs"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function ConnectorSection({
  icon,
  title,
  empty,
  children,
}: {
  icon: React.ReactNode
  title: string
  empty: boolean
  children: React.ReactNode
}) {
  return (
    <section className="border-t border-border px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
        </div>
        {empty ? (
          <p className="text-sm text-muted-foreground">None</p>
        ) : (
          <div className="min-w-0 flex-1 text-right">{children}</div>
        )}
      </div>
    </section>
  )
}

function ConnectorDetail({ connector }: { connector: Connector | null }) {
  if (!connector) {
    return (
      <div className="rounded-lg border border-border bg-card p-8">
        <EmptyState
          icon={<Cable className="h-10 w-10" />}
          title="No connector selected"
          description="Select a connector to view its registered routes and syncs."
        />
      </div>
    )
  }

  return (
    <section className="self-start rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <p className="text-sm text-muted-foreground">{connectorSummary(connector)}</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-normal text-foreground">
          {connectorName(connector)}
        </h2>
      </div>

      <dl className="px-5">
        <DetailRow label="ID" value={connector.id} mono />
        <DetailRow label="Type" value={connector.type} mono />
        <DetailRow label="Outbound client" value={connector.type === "webhook" ? "No" : "Yes"} />
      </dl>

      <ConnectorSection
        icon={<Webhook className="h-4 w-4" />}
        title="Webhooks"
        empty={connector.webhooks.length === 0}
      >
        <div className="space-y-2">
          {connector.webhooks.map((webhook) => (
            <div key={webhook.id}>
              <div className="flex items-center justify-end gap-2">
                <p className="truncate text-sm font-medium text-foreground">
                  {humanizeIdentifier(webhook.id)}
                </p>
                <span className="font-mono text-xs text-muted-foreground">{webhook.method}</span>
              </div>
              <p className="break-all font-mono text-xs text-muted-foreground">{webhook.route}</p>
            </div>
          ))}
        </div>
      </ConnectorSection>

      <ConnectorSection
        icon={<GitBranch className="h-4 w-4" />}
        title="Syncs"
        empty={connector.syncIds.length === 0}
      >
        <div className="space-y-1">
          {connector.syncIds.map((syncId) => (
            <p key={syncId} className="break-all font-mono text-xs text-foreground">
              {syncId}
            </p>
          ))}
        </div>
      </ConnectorSection>
    </section>
  )
}

export function ConnectorsPage() {
  const { data: connectors = [], isLoading, isError } = useQuery(listConnectorsOptions())
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState("")
  const [viewStyle, setViewStyle] = useState<ConnectorListViewStyle>(() =>
    getCollectionViewStyle("connectors", ["cards", "table"], "cards")
  )

  const filteredConnectors = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return connectors

    return connectors.filter((connector) => {
      return (
        connector.id.toLowerCase().includes(query) ||
        connector.type.toLowerCase().includes(query) ||
        connector.webhooks.some((webhook) => webhook.id.toLowerCase().includes(query)) ||
        connector.syncIds.some((syncId) => syncId.toLowerCase().includes(query))
      )
    })
  }, [connectors, searchQuery])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading connectors...</span>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6">
          <EmptyState
            icon={<Cable className="h-10 w-10" />}
            title="Connectors unavailable"
            description="Could not load connector metadata."
          />
        </div>
      </div>
    )
  }

  const handleSelectConnector = (connectorId: string) => {
    navigate(`/connectors/${encodeURIComponent(connectorId)}`)
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <CollectionHeader
        title="Connectors"
        count={filteredConnectors.length}
        actions={
          connectors.length > 0 ? (
            <CollectionViewToggle
              value={viewStyle}
              options={connectorListViewOptions}
              onChange={(style) => {
                setViewStyle(style)
                setCollectionViewStyle("connectors", style)
              }}
            />
          ) : null
        }
      />

      {connectors.length > 0 && (
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search connectors, syncs, or webhooks..."
            className="pl-9"
          />
        </div>
      )}

      <div className="mt-4">
        {connectors.length === 0 ? (
          <EmptyState
            icon={<Cable className="h-10 w-10" />}
            title="No connectors"
            description="Registered connectors will appear here."
          />
        ) : filteredConnectors.length === 0 ? (
          <EmptyState
            icon={<Search className="h-9 w-9" />}
            title="No results"
            description="Try another search."
            className="py-12"
          />
        ) : viewStyle === "table" ? (
          <ConnectorTableView connectors={filteredConnectors} onSelect={handleSelectConnector} />
        ) : (
          <CollectionCardGrid>
            {filteredConnectors.map((connector) => (
              <ConnectorListItem
                key={connector.id}
                connector={connector}
                onSelect={() => handleSelectConnector(connector.id)}
              />
            ))}
          </CollectionCardGrid>
        )}
      </div>
    </div>
  )
}

export function ConnectorDetailPage() {
  const { connectorId = "" } = useParams()
  const navigate = useNavigate()
  const decodedConnectorId = decodeURIComponent(connectorId)

  const {
    data: connector,
    isLoading,
    isError,
  } = useQuery({
    ...getConnectorOptions({
      path: { connectorId: decodedConnectorId },
    }),
    enabled: decodedConnectorId.length > 0,
  })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center py-24">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading connector...</span>
        </div>
      </div>
    )
  }

  if (isError || !connector) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => navigate("/connectors")}
          className="-ml-2 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft />
          Connectors
        </Button>
        <div className="rounded-lg border border-border bg-card p-8">
          <EmptyState
            icon={<Cable className="h-10 w-10" />}
            title="Connector not found"
            description="This connector is not registered in the active Pario runtime."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => navigate("/connectors")}
        className="-ml-2 self-start text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft />
        Connectors
      </Button>
      <ConnectorDetail connector={connector} />
    </div>
  )
}
