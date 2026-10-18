import { InMemoryStorage } from "../src"
import { getInMemoryStorageTestingAdapter } from "../src/storage/in-memory/testing"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import {
  runMaterializationFailureContractSuite,
  runMaterializerStorageContractSuite,
  runOntologyStorageContractSuite,
} from "../src/testing"

runOntologyStorageContractSuite("in-memory ontology storage contract", {
  createStorage: () => new InMemoryStorage(),
})

runMaterializerStorageContractSuite("in-memory materializer storage contract", {
  createStorage: () => new InMemoryStorage(),
  async countCommitTouches(storage) {
    return getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot().commitTouches.size
  },
})

runMaterializationFailureContractSuite("in-memory materialization failure contract", {
  createStorage: () => new InMemoryStorage(),
  captureState(storage) {
    return getInMemoryStorageTestingAdapter(storage).snapshot()
  },
  injectFailure(storage, boundary, failure) {
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeWrite(current) {
        if (current === boundary) throw failure
      },
    })
  },
  clearFailure(storage) {
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({})
  },
})
