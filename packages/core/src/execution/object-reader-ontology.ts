import { isAllowed } from "../authorization"
import {
  type AuthorizedOntologySelection,
  type AuthorizedOntologyView,
  createAuthorizedOntologyView,
} from "../objects/authorized-ontology-view"
import type { OntologyRegistry } from "../ontology"
import { assertObjectReadOutputWithinLimit } from "../storage"
import type { ResolvedExecutionAuthority } from "./object-reader-security"

/** The ontology a reader resolves against, and the part of it its authority may describe. */
export class ObjectReaderOntology {
  readonly registry: OntologyRegistry
  readonly #authority: ResolvedExecutionAuthority
  #view?: AuthorizedOntologyView

  constructor(registry: OntologyRegistry, authority: ResolvedExecutionAuthority) {
    this.registry = registry
    this.#authority = authority
    Object.freeze(this)
  }

  /** Inert metadata for the types the authority may view, built on first use. */
  view(): AuthorizedOntologyView {
    const authority = this.#authority
    this.#view ??= createAuthorizedOntologyView({
      ontology: this.registry,
      selection: selectionForAuthority(authority, this.registry),
      ...(authority.type === "delegated"
        ? {
            assertOutputWithinLimit: (value: unknown) =>
              assertObjectReadOutputWithinLimit(value, authority.objectRead.limits),
          }
        : {}),
    })
    return this.#view
  }
}

function selectionForAuthority(
  authority: ResolvedExecutionAuthority,
  ontology: OntologyRegistry
): AuthorizedOntologySelection {
  switch (authority.type) {
    case "unrestricted":
      return { kind: "all" }
    case "principal":
      return {
        kind: "types",
        objectTypeIds: ontology
          .listObjectTypes()
          .filter((objectType) =>
            isAllowed(authority.context, {
              kind: "object.view",
              objectTypeId: objectType.id,
            })
          )
          .map((objectType) => objectType.id),
      }
    case "delegated":
      return { kind: "selected", scope: authority.objectRead.scope }
  }
}
