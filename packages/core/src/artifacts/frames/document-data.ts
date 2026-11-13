/**
 * A designed document's live data: the fields that show a value (`data-sixb-field`) and the
 * elements repeated once per item (`data-sixb-each`), read from the object that holds the document
 * and from its queries, as one reader reads them.
 *
 * It is served as its own source to the frame runtime, `(${frameRuntime})(${documentData})`, and
 * runs on the server too, over parse5, to write the values in when a version is frozen or printed.
 * So it imports nothing and names nothing outside itself, and walks the markup through a `tree`
 * each side gives it.
 *
 * A path is the steps from where it reads: `client.name`, `scope.services[job-flow].amount`. A
 * step names a property of an object, or a link its query expanded, and `[id]` picks the item of
 * a list whose `id`, or object id, is that; a list read without one reads its first item. It reads
 * the holder, or the item of the repeated element it is in; `query:<name>` reads a query instead,
 * its rows to repeat over, `.total` how many it matched, and `.facets.<property>` its facet values,
 * each with `value` and `count`.
 */
export function documentData(): DocumentData {
  const FIELD = "data-sixb-field"
  const EACH = "data-sixb-each"
  const FORMAT = "data-format"
  const CURRENCY = "data-currency"
  const CURRENCY_FIELD = "data-currency-field"
  const LOCKED = "data-sixb-locked"
  const QUERY = /^query:([a-z0-9][a-z0-9-]{0,63})(?:\.(.*))?$/
  const STEP = /^([A-Za-z_][\w-]*)(?:\[([^\]]+)\])?$/
  /** A value whose source the reader has none of: the written text stays. */
  const UNREAD = Symbol("unread")
  /** A value the reader is not cleared for. */
  const HIDDEN = Symbol("hidden")

  const parse = (path: string): DocumentPath | null => {
    const query = QUERY.exec(path.trim())
    const rest = query ? (query[2] ?? "") : path.trim()
    const steps: DocumentStep[] = []
    for (const part of rest === "" ? [] : rest.split(".")) {
      const step = STEP.exec(part)
      if (!step?.[1]) return null
      steps.push(step[2] === undefined ? { key: step[1] } : { key: step[1], id: step[2] })
    }
    if (!query && steps.length === 0) return null
    return query?.[1] ? { query: query[1], steps } : { steps }
  }

  const isRow = (value: unknown): value is DocumentRow =>
    typeof value === "object" &&
    value !== null &&
    "properties" in value &&
    typeof (value as DocumentRow).properties === "object"

  const step = (value: unknown, next: DocumentStep): unknown => {
    // A list read as one value, as a link to many is, reads its first item.
    if (Array.isArray(value)) return value.length > 0 ? step(value[0], next) : undefined
    let found: unknown
    if (isRow(value)) {
      if (Object.hasOwn(value.properties, next.key)) found = value.properties[next.key]
      else if (value.redactions && Object.hasOwn(value.redactions, next.key)) return HIDDEN
      else found = value.links?.[next.key]
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      found = (value as Record<string, unknown>)[next.key]
    }
    if (next.id === undefined) return found
    if (!Array.isArray(found)) return undefined
    return found.find((item) =>
      isRow(item)
        ? item.primaryId === next.id || item.properties.id === next.id
        : typeof item === "object" && item !== null && (item as { id?: unknown }).id === next.id
    )
  }

  /** What a path reads in `scope`: a value, or UNREAD when its source is not there. */
  const read = (path: DocumentPath, scope: Scope): unknown => {
    let value: unknown
    if (path.query !== undefined) {
      const result = scope.sources.queries[path.query]
      if (!result) return UNREAD
      const [first, second] = path.steps
      if (first?.key === "total" && path.steps.length === 1) return result.total
      if (first?.key === "facets" && second && path.steps.length === 2) {
        return result.facets?.find((facet) => facet.propertyId === second.key)?.buckets
      }
      if (path.steps.length === 0) return result.objects ?? []
      value = result.objects
    } else if (scope.item !== undefined) {
      value = scope.item
    } else {
      if (!scope.sources.holder) return UNREAD
      value = scope.sources.holder
    }
    for (const next of path.steps) {
      if (value === HIDDEN) return HIDDEN
      value = step(value, next)
    }
    return value
  }

  const format = (value: unknown, as: string | null, currency: string | null, lang: string) => {
    if (value === null || value === undefined) return ""
    // A number, or a string that holds one: never what Number() makes 0 of, such as "" or true.
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : Number.NaN
    try {
      if (as === "money" && Number.isFinite(number)) {
        // A whole amount reads without cents, as a price on a proposal does.
        const cents = Number.isInteger(number) ? { minimumFractionDigits: 0 } : {}
        return currency
          ? new Intl.NumberFormat(lang, { style: "currency", currency, ...cents }).format(number)
          : new Intl.NumberFormat(lang, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
              ...cents,
            }).format(number)
      }
      if (as === "number" && Number.isFinite(number)) {
        return new Intl.NumberFormat(lang).format(number)
      }
      if (as === "percent" && Number.isFinite(number)) {
        return new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 2 }).format(
          number
        )
      }
      if (as === "date") {
        const date = new Date(String(value))
        // A date without a time is that day wherever it is read.
        if (!Number.isNaN(date.getTime())) {
          return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(date)
        }
      }
    } catch {
      // A currency or a language Intl does not know: the value as it is.
    }
    if (Array.isArray(value)) {
      return value
        .filter((each) => typeof each !== "object" || each === null)
        .map(String)
        .join(", ")
    }
    return typeof value === "object" ? "" : String(value)
  }

  const fill = <TNode>(root: TNode, tree: DocumentTree<TNode>, options: DocumentFill): void => {
    const lang = options.lang || "en"
    const visit = (node: TNode, scope: Scope) => {
      for (const child of tree.children(node)) {
        const each = tree.attribute(child, EACH)
        if (each !== null) {
          const path = parse(each)
          const items = path ? read(path, scope) : UNREAD
          if (items === UNREAD || items === HIDDEN) {
            // Its written text stays: plain, as written, never to be filled again.
            if (options.plain) unmark(child)
            continue
          }
          const list = Array.isArray(items) ? items : items == null ? [] : [items]
          tree.replace(
            child,
            list.map((item) => {
              const copy = tree.clone(child)
              tree.removeAttribute(copy, EACH)
              visit(copy, { sources: scope.sources, item })
              return copy
            })
          )
          continue
        }

        const field = tree.attribute(child, FIELD)
        if (field === null) {
          visit(child, scope)
          continue
        }
        const path = parse(field)
        const value = path ? read(path, scope) : UNREAD
        if (options.plain) unmark(child)
        if (value === UNREAD) continue
        if (value === HIDDEN) {
          tree.setText(child, "•••")
          if (!options.plain) tree.setAttribute(child, LOCKED, "")
          continue
        }
        const currencyField = tree.attribute(child, CURRENCY_FIELD)
        const currencyPath = currencyField === null ? null : parse(currencyField)
        const currency = currencyPath ? read(currencyPath, scope) : tree.attribute(child, CURRENCY)
        tree.setText(
          child,
          format(
            value,
            tree.attribute(child, FORMAT),
            typeof currency === "string" && currency !== "" ? currency : null,
            lang
          )
        )
      }
    }
    /** No longer marked, nor anything in it, as a frozen version keeps it. */
    const unmark = (node: TNode) => {
      for (const name of [FIELD, EACH, CURRENCY_FIELD]) tree.removeAttribute(node, name)
      for (const child of tree.children(node)) unmark(child)
    }
    visit(root, { sources: options.sources })
  }

  /** Every field and repeated element under `root`, with the repeated elements each sits in. */
  const marks = <TNode>(root: TNode, tree: DocumentTree<TNode>): DocumentMark[] => {
    const found: DocumentMark[] = []
    const visit = (node: TNode, within: readonly string[]) => {
      for (const child of tree.children(node)) {
        const each = tree.attribute(child, EACH)
        const field = tree.attribute(child, FIELD)
        if (each !== null) found.push({ kind: "each", path: each, within })
        if (field !== null) found.push({ kind: "field", path: field, within })
        const currency = tree.attribute(child, CURRENCY_FIELD)
        if (currency !== null) found.push({ kind: "field", path: currency, within })
        visit(child, each === null ? within : [...within, each])
      }
    }
    visit(root, [])
    return found
  }

  /** What marks read: the holder, and the queries named by the outermost path naming one. */
  const reads = (found: readonly DocumentMark[]): DocumentReads => {
    const queries = new Set<string>()
    let holder = false
    for (const mark of found) {
      const named = [...mark.within, mark.path].map(parse).find((path) => path?.query)
      if (named?.query) queries.add(named.query)
      else holder = true
    }
    return { holder, queries: [...queries] }
  }

  return { parse, fill, marks, reads }
}

/** Where a path reads: the sources, and the item of the repeated element it is in. */
interface Scope {
  readonly sources: DocumentSources
  readonly item?: unknown
}

/** One step of a path: a key, and the id of the list item it picks. */
export interface DocumentStep {
  readonly key: string
  readonly id?: string
}

/** A field's or a repeated element's path: the query it reads, else the holder or the item. */
export interface DocumentPath {
  readonly query?: string
  readonly steps: readonly DocumentStep[]
}

/** A row as a query returns it. */
export interface DocumentRow {
  readonly primaryId?: string
  readonly properties: Readonly<Record<string, unknown>>
  readonly links?: Readonly<Record<string, unknown>>
  readonly redactions?: Readonly<Record<string, unknown>>
}

/** A query's result as its route answers, which is all a field reads of it. */
export interface DocumentQueryResult {
  readonly objects?: readonly DocumentRow[]
  readonly total?: number
  readonly facets?: readonly {
    readonly propertyId: string
    readonly buckets: readonly { readonly value: unknown; readonly count: number }[]
  }[]
}

/** What a reader read: the holder, and each query by name. One left out keeps its written text. */
export interface DocumentSources {
  readonly holder?: DocumentRow
  readonly queries: Readonly<Record<string, DocumentQueryResult>>
}

export interface DocumentFill {
  readonly sources: DocumentSources
  /** `<html lang>`, which the values are formatted for. */
  readonly lang?: string
  /** Writes plain HTML, as a frozen version keeps it: no field stays marked. */
  readonly plain?: boolean
}

/** A field or a repeated element, with the paths of the repeated elements around it. */
export interface DocumentMark {
  readonly kind: "field" | "each"
  readonly path: string
  readonly within: readonly string[]
}

/** How the walk reads and changes the markup: the DOM in a frame, parse5 on the server. */
export interface DocumentTree<TNode> {
  /** Its child elements, in order. */
  children(node: TNode): readonly TNode[]
  attribute(node: TNode, name: string): string | null
  setAttribute(node: TNode, name: string, value: string): void
  removeAttribute(node: TNode, name: string): void
  /** Its content, replaced by this text. */
  setText(node: TNode, text: string): void
  /** A deep copy, not yet anywhere. */
  clone(node: TNode): TNode
  /** Puts these where it is, in its place. */
  replace(node: TNode, nodes: readonly TNode[]): void
}

/** What a document's fields read. */
export interface DocumentReads {
  readonly holder: boolean
  readonly queries: readonly string[]
}

export interface DocumentData {
  /** A path, or null when it is not one. */
  parse(path: string): DocumentPath | null
  /** Shows the values the sources hold in the fields and repeated elements under `root`. */
  fill<TNode>(root: TNode, tree: DocumentTree<TNode>, options: DocumentFill): void
  marks<TNode>(root: TNode, tree: DocumentTree<TNode>): DocumentMark[]
  reads(marks: readonly DocumentMark[]): DocumentReads
}
