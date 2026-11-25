/** Branches off production: the copy production sends, and the runtime a laptop runs it on. */

export { type CopyForBranchInput, copyForBranch } from "./copy"
export {
  authorizeBranchCredential,
  BRANCH_CREDENTIAL_PREFIX,
  branchCredentialSlice,
  isBranchCredentialRoute,
  isBranchSliceRelease,
} from "./credential"
export { type BranchRuntime, branchRuntimeOf, hostOnBranch } from "./runtime"
export {
  type BranchCopyLake,
  type BranchCopyReader,
  encodeBranchCopyPart,
  readBranchCopy,
} from "./wire"
