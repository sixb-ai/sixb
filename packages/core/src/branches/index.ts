/**
 * Branches off production: the copy production sends, the runtime a branch runs it on, on a laptop
 * or next to production, and a hosted branch's home on production's instance. See README.md.
 */

export { type CopyForBranchInput, copyForBranch } from "./copy"
export { takeBranchCopySlot } from "./copy-slots"
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
export {
  assertMayManageBranches,
  type BranchesRuntime,
  type BranchView,
  toBranchView,
} from "./execution"
export {
  BRANCH_HANDOVER_CODE_TTL_MS,
  BRANCH_HANDOVER_PREPARE_PATH,
  BRANCH_HANDOVER_SIGN_IN_PATH,
  BRANCH_HANDOVER_STRATEGY_ID,
  BRANCH_SESSION_MAX_MS,
  BranchHandover,
  type BranchHandoverPerson,
  branchHandoverAuth,
} from "./handover"
export {
  assertPreviewSiteApart,
  branchPreviewOrigin,
  previewNamespaceOf,
  siteOf,
} from "./preview"
export {
  BRANCH_COPIES_DIRECTORY,
  BRANCH_DATABASE_SCHEMA_ENV,
  BRANCH_DATABASE_URL_ENV,
  BRANCH_KEY_ENV,
  BRANCH_KEY_HEADER,
  BRANCH_PORT_ENV,
  BRANCH_PUBLIC_ORIGIN_ENV,
  BRANCH_RUNTIME_COMMAND,
  BRANCH_STATUS_PATH,
  type BranchLoadedCopy,
  type BranchRuntime,
  type BranchRuntimeStatus,
  branchRuntimeOf,
  HOSTED_BRANCH_COPY,
  hostOnBranch,
  isBranchApiPath,
  parseBranchRuntimeStatus,
  parseLoadedCopy,
} from "./runtime"
export {
  assertGitBranchName,
  BRANCH_BUN_COMMAND,
  BRANCH_BUN_VERSION,
  BRANCH_CHECKOUT_MARK,
  BRANCH_DEPENDENCY_FILES,
  BRANCH_INSTALL_COMMAND,
  type BranchCheckoutStep,
  branchCheckout,
  type ProjectSource,
  sourceGitUrl,
} from "./source"
export {
  type BranchCopyLake,
  type BranchCopyReader,
  encodeBranchCopyPart,
  readBranchCopy,
} from "./wire"
