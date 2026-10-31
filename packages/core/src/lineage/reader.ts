import { canViewPrimitiveRun, isRuntimeAllowed, type PrimitiveRunSubject } from "../authorization"
import { AuthorizationError } from "../authorization/errors"
import {
  type ResolvedRuntimeAuthorization,
  resolveRuntimeAuthorizationForProject,
} from "../execution/authorization"
import type { OntologyObjectRef } from "../materialization/model"
import type { SixbRuntimeContext } from "../runtime/types"
import type { ObjectRow } from "../storage"
import { objectBatchKey } from "../storage/objects/keys"

/**
 * Who a lineage is assembled for, and the steps it leaves out for them. Each step is authorized on
 * its own with the guard that already protects it elsewhere; one the reader cannot view is left
 * out without its identity and counted once, by key.
 */
export class LineageReader {
  readonly #restricted = new Set<string>()

  private constructor(
    readonly runtime: SixbRuntimeContext,
    readonly authority: Extract<
      ResolvedRuntimeAuthorization,
      { readonly type: "principal" | "unrestricted" }
    >
  ) {}

  /** Null for denied and delegated (shared link) authority, which see no lineage, as no run. */
  static for(runtime: SixbRuntimeContext): LineageReader | null {
    const authority = resolveRuntimeAuthorizationForProject(runtime)
    switch (authority.type) {
      case "denied":
      case "delegated":
        return null
      case "principal":
      case "unrestricted":
        return new LineageReader(runtime, authority)
    }
  }

  get restricted(): number {
    return this.#restricted.size
  }

  /** Leave a step out. `step` names it uniquely, such as `dataset:<id>`, and is never shown. */
  restrict(step: string): void {
    this.#restricted.add(step)
  }

  canViewDataset(datasetId: string): boolean {
    return isRuntimeAllowed(this.runtime, { kind: "dataset.view", datasetId })
  }

  /** Decided as the primitive's run facade decides. */
  canViewRun(run: PrimitiveRunSubject): boolean {
    return (
      this.authority.type === "unrestricted" || canViewPrimitiveRun(this.authority.context, run)
    )
  }

  /**
   * These objects as the reader reads them now, view conditions and markings applied, or null
   * when one is hidden or missing.
   */
  async readObjects(refs: readonly OntologyObjectRef[]): Promise<readonly ObjectRow[] | null> {
    try {
      const rows = await this.runtime.objectReader.getByPrimaryIdBatch({ items: refs })
      const found = refs.map((ref) => rows.get(objectBatchKey(ref.objectTypeId, ref.primaryId)))
      return found.every((row) => row !== undefined) ? found : null
    } catch (error) {
      if (error instanceof AuthorizationError) return null
      throw error
    }
  }

  /** Whether the reader may read links of this kind: their markings applied. */
  async canReadLink(sourceTypeId: string, linkId: string): Promise<boolean> {
    try {
      await this.runtime.objectReader.assertReadable({
        objectTypeIds: [],
        links: [{ objectTypeId: sourceTypeId, linkId }],
      })
      return true
    } catch (error) {
      if (error instanceof AuthorizationError) return false
      throw error
    }
  }
}
