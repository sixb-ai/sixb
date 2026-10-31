import { useSectionOpen } from "../../../sections/sections"
import { projectionHref } from "../../routes"
import { humanize } from "../../section-ui"
import { useActionName } from "./action-name"
import { MaybeLink } from "./links"
import { useLineageMessages } from "./messages"
import { lineageSummary, type ObjectLineage, projectionOpens } from "./model"
import { SeparatedFacts } from "./separated"

/**
 * Where the object comes from, for its page's header: "Imported from Billing · 2 values edited".
 * It takes a line of its own under the header's other facts, so it wraps on a phone without
 * stranding a dot.
 */
export function LineageSummary({ lineage }: { readonly lineage: ObjectLineage }) {
  const messages = useLineageMessages().summary
  const dataOpen = useSectionOpen("data")
  const { existence, edited } = lineageSummary(lineage)
  const creator = useActionName(existence?.kind === "edit" ? existence.action?.actionId : undefined)

  const facts = [
    ...(existence?.kind === "projection"
      ? [
          {
            key: "imported",
            node: (
              <span>
                {messages.importedFrom}{" "}
                <MaybeLink
                  to={
                    dataOpen && projectionOpens(existence)
                      ? projectionHref(existence.projectionId)
                      : null
                  }
                  className="text-foreground"
                >
                  {humanize(existence.projectionId)}
                </MaybeLink>
              </span>
            ),
          },
        ]
      : []),
    ...(existence?.kind === "edit"
      ? [
          {
            key: "created",
            node: <span>{creator ? messages.createdBy(creator) : messages.createdByEdit}</span>,
          },
        ]
      : []),
    ...(edited > 0 ? [{ key: "edited", node: <span>{messages.edited(edited)}</span> }] : []),
  ]
  if (facts.length === 0) return null

  // The header's dots are drawn in this color.
  return <SeparatedFacts facts={facts} className="basis-full" dotClassName="text-border" />
}
