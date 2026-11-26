/**
 * Branches off production: the copy production sends, the runtime a branch runs it on, on a laptop
 * or next to production, and a hosted branch's home on production's instance. See README.md.
 */

export { type CopyForBranchInput, copyForBranch } from "./copy"
export {
  authorizeBranchCredential,
  BRANCH_CREDENTIAL_PREFIX,
  branchCredentialSlice,
  isBranchCredentialRoute,
  isBranchSliceRelease,
} from "./credential"
export {
  type BranchClosure,
  type BranchEnforcement,
  type BranchHostingStorage,
  type BranchRoleLimits,
  branchClosureNotice,
  branchDatabaseAddress,
  branchHostingRequirement,
  branchNamespaceName,
  closeBranchData,
  dropBranchData,
  enforceBranchLimits,
  hostBranchDatabase,
  isBranchHostingStorage,
  prepareBranchData,
} from "./data"
export { type BranchRuntime, branchRuntimeOf, hostOnBranch } from "./runtime"
export {
  type BranchCopyLake,
  type BranchCopyReader,
  encodeBranchCopyPart,
  readBranchCopy,
} from "./wire"
