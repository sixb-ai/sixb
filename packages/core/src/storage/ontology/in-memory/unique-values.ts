import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import type {
  OntologyUniqueValueStorage,
  PreparedUniqueProperty,
  UniqueValueEntry,
} from "../unique-values"

/** Unique values live with the in-memory objects, so a transaction snapshot covers both. */
export class InMemoryOntologyUniqueValueStorage implements OntologyUniqueValueStorage {
  constructor(
    private readonly objects: InMemoryObjectStorage,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  ) {}

  /** In-memory transactions already run one at a time. */
  async lockPreparation(_input: { readonly projectId: string }): Promise<void> {}

  async listPrepared(input: {
    readonly projectId: string
  }): Promise<readonly PreparedUniqueProperty[]> {
    return this.runRootOperation(() => this.adapter().listPreparedUniqueProperties(input.projectId))
  }

  async clear(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly propertyId: string
  }): Promise<void> {
    await this.runRootOperation(() =>
      this.adapter().clearUniqueProperty(input.projectId, input.objectTypeId, input.propertyId)
    )
  }

  async insert(input: {
    readonly projectId: string
    readonly objectTypeId: string
    readonly propertyId: string
    readonly entries: readonly UniqueValueEntry[]
  }): Promise<void> {
    await this.runRootOperation(() =>
      this.adapter().insertUniqueValues(
        input.projectId,
        input.objectTypeId,
        input.propertyId,
        input.entries
      )
    )
  }

  async markPrepared(
    input: PreparedUniqueProperty & { readonly projectId: string; readonly preparedAt: string }
  ): Promise<void> {
    await this.runRootOperation(() => this.adapter().markUniquePropertyPrepared(input))
  }

  private adapter() {
    return getInMemoryObjectMaterializerAdapter(this.objects)
  }
}
