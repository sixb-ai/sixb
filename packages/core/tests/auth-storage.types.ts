import { InMemoryAuthStorage, InMemoryStorage } from "../src"
import type {
  AuthStorage,
  CompleteMagicLinkSignInInput,
  GroupMembershipRecord,
  SessionRecord,
  UserRecord,
} from "../src/storage"

const authStorage: AuthStorage = new InMemoryAuthStorage()
const storage = new InMemoryStorage()
const storageAuth: AuthStorage = storage.auth

const user: UserRecord = {
  id: "usr_1",
  projectId: "project-a",
  email: "ava@acme.com",
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
}

const session: SessionRecord = {
  id: "ses_1",
  projectId: "project-a",
  userId: user.id,
  strategyId: "magic-link",
  audience: "atlas",
  tokenHash: "hash",
  createdAt: new Date(),
  expiresAt: new Date(),
}

const membership: GroupMembershipRecord = {
  projectId: "project-a",
  userId: user.id,
  groupId: "commercial",
  source: "manual",
  createdAt: new Date(),
}

const completeMagicLinkInput: CompleteMagicLinkSignInInput = {
  projectId: "project-a",
  magicLinkId: "ml_1",
  tokenHash: "hash",
  completedAt: new Date(),
  newUserId: "usr_1",
  session: {
    id: "ses_1",
    audience: "atlas",
    tokenHash: "session-hash",
    createdAt: new Date(),
    expiresAt: new Date(),
  },
}

void authStorage
void storageAuth
void session
void membership
void completeMagicLinkInput
