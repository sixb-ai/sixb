import {
  type AuthorizedOntologySelection,
  type AuthorizedOntologyView,
  createAuthorizedOntologyView,
} from "../objects/authorized-ontology-view"
import type { OntologyRegistry } from "../ontology"
import { assertObjectReadOutputWithinLimit } from "../storage"
import type { ObjectReaderSecurity } from "./object-reader-security"

/** The ontology a reader resolves against, and the part of it its authority may describe. */
export class ObjectReaderOntology {
  readonly registry: OntologyRegistry
  readonly #security: ObjectReaderSecurity
  #view?: AuthorizedOntologyView

  constructor(registry: OntologyRegistry, security: ObjectReaderSecurity) {
    this.registry = registry
    this.#security = security
    Object.freeze(this)
  }

  /** Inert metadata for the types the authority may view, built on first use. */
  view(): AuthorizedOntologyView {
    const authority = this.#security.authority
    this.#view ??= createAuthorizedOntologyView({
      ontology: this.registry,
      selection: selectionForAuthority(this.#security, this.registry),
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
  security: ObjectReaderSecurity,
  ontology: OntologyRegistry
): AuthorizedOntologySelection {
  const authority = security.authority

  switch (authority.type) {
    case "unrestricted":
      return { kind: "all" }
    case "principal":
      return {
        kind: "types",
        objectTypeIds: ontology
          .listObjectTypes()
          // A type viewed through a condition is listed: the reader reads the objects it matches.
          .filter((objectType) => security.isObjectTypeGranted(objectType.id, undefined))
          .map((objectType) => objectType.id),
      }
    case "delegated":
      return { kind: "selected", scope: authority.objectRead.scope }
  }
}
