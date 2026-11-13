import { type DocumentMark, type DocumentPath, documentData } from "../frames/document-data"
import type { DocumentHolder } from "../outline"
import type { ArtifactQueryProperty, CheckedArtifactQuery } from "../queries"
import type { ArtifactWarning } from "../warnings"
import { invalidArtifact } from "./files"
import type { ArtifactQueryChecker } from "./queries"

type Properties = Readonly<Record<string, ArtifactQueryProperty>>

/**
 * What a path reads from: the holder, a query's rows, an item of what a holder's property or link
 * holds, which only the holder's type tells apart, or what is not checked.
 */
type Base =
  | { readonly kind: "holder" }
  | { readonly kind: "rows"; readonly query: CheckedArtifactQuery }
  | { readonly kind: "item"; readonly key: string }
  | { readonly kind: "unknown" }

/**
 * Checks a designed document's fields and repeated elements against what they read, as its author
 * reads it: the object that holds it, of the type it names, and its queries. A path that reads
 * nothing they hold is a `field_unknown` warning, never a refusal, so a document that names a
 * property its author cannot see still publishes. One that reads a list item, or a value deeper
 * than a property, is not checked past it.
 *
 * Returns the holder, with the links its fields read through, which reading the holder expands.
 * A holder its author cannot read refuses the version, as a query they could not run does.
 */
export async function checkDocumentFields(input: {
  readonly marks: readonly DocumentMark[]
  readonly holder?: string
  readonly queries: ReadonlyMap<string, CheckedArtifactQuery>
  readonly checker?: ArtifactQueryChecker
}): Promise<{ readonly holder?: DocumentHolder; readonly warnings: readonly ArtifactWarning[] }> {
  const data = documentData()
  const warnings: ArtifactWarning[] = []
  const unknown = (mark: DocumentMark, why: string) =>
    warnings.push({
      code: "field_unknown",
      message: `data-sixb-${mark.kind}="${mark.path}" ${why}. It keeps the text written in it.`,
    })

  /** What a path reads from, given the repeated elements it is in. */
  const baseOf = (path: DocumentPath, within: readonly string[]): Base => {
    if (path.query !== undefined) {
      const query = input.queries.get(path.query)
      return query ? { kind: "rows", query } : { kind: "unknown" }
    }
    const each = within.at(-1)
    if (each === undefined) return { kind: "holder" }
    const parsed = data.parse(each)
    if (!parsed) return { kind: "unknown" }
    if (parsed.query !== undefined && parsed.steps.length === 0) return baseOf(parsed, [])
    const [step, ...rest] = parsed.steps
    const repeatsHolder = baseOf(parsed, within.slice(0, -1)).kind === "holder"
    return step && rest.length === 0 && step.id === undefined && repeatsHolder
      ? { kind: "item", key: step.key }
      : { kind: "unknown" }
  }

  const reads = input.marks.flatMap((mark) => {
    const path = data.parse(mark.path)
    if (!path) {
      unknown(mark, "is not a path: name properties with dots, and a list's item by its id in [ ]")
      return []
    }
    return [{ mark, path, base: baseOf(path, mark.within) }]
  })

  // A holder's properties, and those of the objects each link its fields name reaches.
  let holder: DocumentHolder | undefined
  let holderProperties: Properties = {}
  const linkProperties = new Map<string, Properties>()
  const readsHolder = reads.some((read) => read.base.kind === "holder")
  if (readsHolder && !input.holder) {
    warnings.push({
      code: "field_unknown",
      message:
        'The document\'s fields read the object that holds it, but it names no type of object: add <meta name="sixb:object-type" content="..."> to its <head>. They keep the text written in them.',
    })
  }
  if (input.holder) {
    if (!input.checker) {
      throw invalidArtifact(
        "The document shows live data of the object that holds it, and this publish has no way to check that its author reads it."
      )
    }
    const objectTypeId = input.holder
    const start = { kind: "start", objectTypeId } as const
    try {
      holderProperties = (await input.checker({ kind: "objects", query: start })).schema.properties
    } catch (error) {
      throw invalidArtifact(
        `The document names the object type '${objectTypeId}' in <meta name="sixb:object-type">, which you cannot read: ${error instanceof Error ? error.message.replace(/^\[Sixb\]\s*/, "") : String(error)}`
      )
    }

    // A first step that is no property may be a link: its objects are read with the holder.
    const candidates = new Set<string>()
    for (const { base, path } of reads) {
      const first = path.steps[0]?.key
      if (base.kind === "holder" && first && !Object.hasOwn(holderProperties, first)) {
        candidates.add(first)
      }
    }
    for (const linkId of candidates) {
      try {
        const checked = await input.checker({
          kind: "objects",
          query: { kind: "expand", input: start, expansions: [{ linkId, direction: "outgoing" }] },
        })
        linkProperties.set(linkId, checked.schema.links[linkId]?.properties ?? {})
      } catch {
        // Neither a property nor a link: its fields are warned about below.
      }
    }
    holder = { objectTypeId, links: [...linkProperties.keys()] }
  }

  for (const { mark, path, base } of reads) {
    const [first, second] = path.steps
    switch (base.kind) {
      case "unknown":
        if (path.query !== undefined)
          unknown(mark, `names no query: add queries/${path.query}.json`)
        break
      case "rows": {
        const facets = base.query.kind === "facets"
        if (path.query !== undefined) {
          if (mark.kind === "field" && first?.key === "total" && path.steps.length === 1) break
          if (first?.key === "facets" && path.steps.length === 2 && facets) break
          if (mark.kind === "each" && path.steps.length === 0 && !facets) break
          unknown(
            mark,
            facets
              ? `reads facets: repeat over query:${path.query}.facets.<property>, or show query:${path.query}.total`
              : `reads rows: repeat over query:${path.query}, or show query:${path.query}.total`
          )
          break
        }
        if (!first) break
        const links = base.query.schema.links
        if (Object.hasOwn(base.query.schema.properties, first.key)) break
        if (Object.hasOwn(links, first.key)) {
          if (second && !Object.hasOwn(links[first.key]?.properties ?? {}, second.key)) {
            unknown(mark, `reads '${second.key}', which what '${first.key}' reaches does not hold`)
          }
          break
        }
        unknown(mark, `reads '${first.key}', which the rows of its query do not hold`)
        break
      }
      case "item": {
        // An item of a property's list is not checked; one the holder lacks is warned about once.
        const reached = linkProperties.get(base.key)
        if (reached && first && !Object.hasOwn(reached, first.key)) {
          unknown(mark, `reads '${first.key}', which what '${base.key}' reaches does not hold`)
        }
        break
      }
      case "holder": {
        if (!input.holder || !first) break
        if (Object.hasOwn(holderProperties, first.key)) break
        const reached = linkProperties.get(first.key)
        if (!reached) {
          unknown(mark, `reads '${first.key}', which a ${input.holder} does not hold`)
        } else if (second && !Object.hasOwn(reached, second.key)) {
          unknown(mark, `reads '${second.key}', which what '${first.key}' reaches does not hold`)
        }
        break
      }
    }
  }

  return { ...(holder ? { holder } : {}), warnings }
}
