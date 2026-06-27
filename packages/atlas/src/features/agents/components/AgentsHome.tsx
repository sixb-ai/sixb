import { cn } from "@sixb/ui/lib/utils"
import { useMemo } from "react"
import { formatRelativeTime, groupThreadsByDate } from "../format"
import type { Agent, AgentThread } from "../types"
import { AgentAvatar } from "./AgentAvatar"

export interface AgentsHomeProps {
  readonly agents: readonly Agent[]
  readonly threads: readonly AgentThread[]
  readonly agentsById: ReadonlyMap<string, Agent>
  readonly threadsError?: string | null
  readonly onPickAgent: (agentId: string) => void
  readonly onSelectThread: (threadId: string) => void
}

/**
 * The Agents landing: explore agents and pick up recent chats in one full-width page — no separate
 * thread sidebar. Self-contained so it can also be embedded in a custom app.
 */
export function AgentsHome({
  agents,
  threads,
  agentsById,
  threadsError,
  onPickAgent,
  onSelectThread,
}: AgentsHomeProps) {
  const groups = useMemo(() => groupThreadsByDate(threads), [threads])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-8 lg:py-10">
        <section>
          <h2 className="text-lg font-semibold text-foreground">Agents</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Start a new chat with one of your agents.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onPickAgent(agent.id)}
                className="group flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40"
              >
                <div className="flex items-center gap-2.5">
                  <AgentAvatar name={agent.name} className="size-9 text-sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
                    {agent.modelId ? (
                      <p className="truncate text-xs text-muted-foreground">{agent.modelId}</p>
                    ) : null}
                  </div>
                </div>
                {agent.description ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground">{agent.description}</p>
                ) : null}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold text-foreground">Recent chats</h2>
          {threadsError ? (
            <p className="mt-2 text-sm text-destructive">{threadsError}</p>
          ) : threads.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No chats yet.</p>
          ) : (
            <div className="mt-3 space-y-4">
              {groups.map((group) => (
                <div key={group.label}>
                  <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </p>
                  <div className="overflow-hidden rounded-lg border border-border">
                    {group.threads.map((thread, index) => (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => onSelectThread(thread.id)}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                          index > 0 && "border-t border-border"
                        )}
                      >
                        <AgentAvatar
                          name={agentsById.get(thread.agentId)?.name ?? "?"}
                          className="size-6 text-[10px]"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {thread.title?.trim() || "Untitled chat"}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatRelativeTime(thread.lastMessageAt ?? thread.updatedAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
