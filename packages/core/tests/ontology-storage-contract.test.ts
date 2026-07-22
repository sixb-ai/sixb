import { InMemoryStorage } from "../src"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { InMemoryProjectionRunStorage } from "../src/storage/projection-runs/in-memory"
import {
  runMaterializationFailureContractSuite,
  runMaterializerStorageContractSuite,
  runOntologyStorageContractSuite,
  runProjectionRunStorageContractSuite,
} from "../src/testing"

runOntologyStorageContractSuite("in-memory ontology storage contract", {
  createStorage: () => new InMemoryStorage(),
})

runMaterializerStorageContractSuite("in-memory materializer storage contract", {
  createStorage: () => new InMemoryStorage(),
})

runProjectionRunStorageContractSuite("in-memory projection-run storage contract", {
  createStorage: () => {
    let ordinal = 0
    return new InMemoryProjectionRunStorage({ executionToken: () => `contract-token-${++ordinal}` })
  },
})

runMaterializationFailureContractSuite("in-memory materialization failure contract", {
  createStorage: () => new InMemoryStorage(),
  captureState(storage) {
    return {
      objects: storage.objects.snapshot(),
      timeseries: storage.timeseries.snapshot(),
      ontology: getInMemoryOntologyStorageTestingAdapter(storage.ontology).snapshot(),
      projectionRuns: storage.projectionRuns.snapshot(),
    }
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
