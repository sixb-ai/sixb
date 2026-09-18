import {
  BlobSASPermissions,
  type BlobServiceClient,
  type BlockBlobClient,
  SASProtocol,
  StorageSharedKeyCredential,
  type UserDelegationKey,
} from "@azure/storage-blob"

const CLOCK_SKEW_MS = 5 * 60 * 1000
const KEY_LIFETIME_MS = 2 * 60 * 60 * 1000

/** One refresh per provider, shared by concurrent signers; failed refreshes are retryable. */
export function delegationKeyCache(
  load: (startsOn: Date, expiresOn: Date) => Promise<UserDelegationKey>
): (expiresAt: Date) => Promise<UserDelegationKey> {
  let cached: UserDelegationKey | undefined
  let pending: Promise<UserDelegationKey> | undefined
  return async (expiresAt) => {
    if (cached && cached.signedExpiresOn.getTime() >= expiresAt.getTime() + CLOCK_SKEW_MS) {
      return cached
    }
    pending ??= load(new Date(Date.now() - CLOCK_SKEW_MS), new Date(Date.now() + KEY_LIFETIME_MS))
      .then((key) => {
        cached = key
        return key
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}

interface SigningService {
  readonly credential: BlobServiceClient["credential"]
  getUserDelegationKey(startsOn: Date, expiresOn: Date): Promise<UserDelegationKey>
}

export function uploadSigner(service: SigningService) {
  const getKey = delegationKeyCache((start, end) => service.getUserDelegationKey(start, end))
  return async (blob: BlockBlobClient, expiresAt: Date): Promise<string> => {
    const options = {
      permissions: BlobSASPermissions.parse("cw"),
      startsOn: new Date(Date.now() - CLOCK_SKEW_MS),
      expiresOn: expiresAt,
      protocol: blob.url.startsWith("https:") ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
    }
    if (service.credential instanceof StorageSharedKeyCredential) {
      return blob.generateSasUrl(options)
    }
    return blob.generateUserDelegationSasUrl(options, await getKey(expiresAt))
  }
}
