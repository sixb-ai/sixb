import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { Check } from "lucide-react"
import type { ReactNode } from "react"
import type { Overview } from "./format"
import { useAiUsageMessages } from "./messages"
import {
  bucketLabel,
  colorOf,
  type FilterKey,
  type ModelKind,
  type SpendFilters,
  type SpendRange,
} from "./spend-model"

export type Requester = NonNullable<Overview["people"][number]["requester"]>

export const personValue = (requester: Requester | undefined) =>
  requester ? `${requester.type}:${requester.id}` : "none"

/** What a person, a source and a kind are called on this page, for chips, rows and menus. */
export function useNames() {
  const messages = useAiUsageMessages().breakdown
  const kinds = useAiUsageMessages().kinds.names
  return {
    person: (requester: Requester | undefined) =>
      requester ? requester.name || requester.email || requester.id : messages.nobody,
    source: (source: string) =>
      source === "agent"
        ? messages.chats
        : source === "action"
          ? messages.actions
          : source === "other"
            ? messages.other
            : source.slice("workflow:".length),
    kind: (kind: ModelKind | undefined) => (kind ? kinds[kind] : kinds.unclassified),
  }
}

/** The chip text for a filter's value. */
export function useFilterLabels(overview: Overview | undefined, range: SpendRange) {
  const messages = useAiUsageMessages().filter
  const names = useNames()
  const locale = useLocale()
  return {
    value(key: FilterKey, value: string, filters: SpendFilters): string {
      switch (key) {
        case "day":
          return bucketLabel(value, range.bucket, locale)
        case "model":
          return value
        case "provider":
          return filters.model ?? value
        case "person": {
          const person = overview?.people.find((entry) => personValue(entry.requester) === value)
          return person ? names.person(person.requester) : value.slice(value.indexOf(":") + 1)
        }
        case "source":
          return names.source(value)
        case "kind":
          return names.kind(value as ModelKind)
        case "price":
          return messages.unpriced
      }
    },
  }
}

/** The Filter button's menu: every model, person, source and kind the range has. */
export function FilterMenu({
  overview,
  palette,
  filters,
  onFilter,
  onModel,
  children,
}: {
  readonly overview: Overview | undefined
  readonly palette: ReadonlyMap<string, string>
  readonly filters: SpendFilters
  readonly onFilter: (key: FilterKey, value: string | undefined) => void
  readonly onModel: (model: { providerId: string; modelId: string } | undefined) => void
  readonly children: ReactNode
}) {
  const messages = useAiUsageMessages()
  const names = useNames()
  const sources = [
    ...(overview?.agents.some((agent) => agent.kind === "agent") ? ["agent"] : []),
    ...(overview?.workflows.map((workflow) => `workflow:${workflow.workflowId}`) ?? []),
    "action",
    "other",
  ]
  const menus: {
    key: string
    label: string
    items: { id: string; label: string; on: boolean; color?: string; pick: () => void }[]
  }[] = [
    {
      key: "model",
      label: messages.filter.names.model,
      items: (overview?.models ?? []).map((model) => ({
        id: `${model.providerId}/${model.modelId}`,
        label: model.modelId,
        color: colorOf(palette, `${model.providerId}/${model.modelId}`),
        on: filters.provider === model.providerId && filters.model === model.modelId,
        pick: () => onModel(model),
      })),
    },
    {
      key: "person",
      label: messages.filter.names.person,
      items: (overview?.people ?? []).map((person) => ({
        id: personValue(person.requester),
        label: names.person(person.requester),
        on: filters.person === personValue(person.requester),
        pick: () => onFilter("person", personValue(person.requester)),
      })),
    },
    {
      key: "source",
      label: messages.filter.names.source,
      items: sources.map((source) => ({
        id: source,
        label: names.source(source),
        on: filters.source === source,
        pick: () => onFilter("source", source),
      })),
    },
    {
      key: "kind",
      label: messages.filter.names.kind,
      items: (overview?.kinds ?? []).flatMap((kind) =>
        kind.modelKind
          ? [
              {
                id: kind.modelKind,
                label: names.kind(kind.modelKind),
                on: filters.kind === kind.modelKind,
                pick: () => onFilter("kind", kind.modelKind),
              },
            ]
          : []
      ),
    },
  ]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {menus.map((menu) => (
          <DropdownMenuSub key={menu.key}>
            <DropdownMenuSubTrigger disabled={menu.items.length === 0}>
              {menu.label}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
              {menu.items.map((item) => (
                <DropdownMenuItem key={item.id} onSelect={item.pick}>
                  {item.color ? (
                    <span
                      className="size-2.5 shrink-0 rounded-[3px]"
                      style={{ background: item.color }}
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.on ? <Check className="size-4" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
