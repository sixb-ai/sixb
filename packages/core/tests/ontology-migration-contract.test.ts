import { InMemoryStorage } from "../src"
import { runOntologyMigrationContractSuite } from "../src/testing/ontology-migration-contract"

runOntologyMigrationContractSuite("in-memory", {
  createStorage: () => new InMemoryStorage(),
})
