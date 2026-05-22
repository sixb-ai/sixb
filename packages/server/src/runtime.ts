import type { OntologySource, ParioInstance, ParioRuntimeContext } from "@pario/core"

export type ParioServerRuntime = ParioInstance<readonly OntologySource[]> & ParioRuntimeContext
