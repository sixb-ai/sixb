import { createImapClient } from "./client"
import { imapConnectorError } from "./errors"
import type { ImapConnection, ImapConnector } from "./types"

/**
 * Create a read-only IMAP connector backed by ImapFlow.
 *
 * The connected value is a stateless gateway: every operation opens and closes its own
 * authenticated TLS session so a stale socket is never retained by the Sixb connector runtime.
 */
export function imap(connection: ImapConnection): ImapConnector {
  const normalizedConnection = normalizeConnection(connection)

  return {
    type: "imap",
    async connect(context) {
      if (context.signal.aborted) {
        throw imapConnectorError("Operation aborted.", { code: "runtime.cancelled" })
      }
      return createImapClient(normalizedConnection, context.signal)
    },
    disconnect(client) {
      return client.close()
    },
  }
}

function normalizeConnection(connection: ImapConnection): ImapConnection {
  const host = connection.host?.trim()
  const user = connection.auth?.user?.trim()

  if (!host) {
    throw imapConnectorError("host must not be empty.")
  }
  if (!user) {
    throw imapConnectorError("auth.user must not be empty.")
  }
  if (!connection.auth?.pass) {
    throw imapConnectorError("auth.pass must not be empty.")
  }
  validatePort(connection.port)
  validateTimeout("connectTimeoutMs", connection.connectTimeoutMs)
  validateTimeout("socketTimeoutMs", connection.socketTimeoutMs)

  const servername = connection.tls?.servername?.trim()
  if (connection.tls?.servername !== undefined && !servername) {
    throw imapConnectorError("tls.servername must not be empty when provided.")
  }

  return {
    host,
    ...(connection.port === undefined ? {} : { port: connection.port }),
    auth: { user, pass: connection.auth.pass },
    ...(connection.tls
      ? {
          tls: {
            ...(connection.tls.rejectUnauthorized === undefined
              ? {}
              : { rejectUnauthorized: connection.tls.rejectUnauthorized }),
            ...(servername ? { servername } : {}),
          },
        }
      : {}),
    ...(connection.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: connection.connectTimeoutMs }),
    ...(connection.socketTimeoutMs === undefined
      ? {}
      : { socketTimeoutMs: connection.socketTimeoutMs }),
  }
}

function validatePort(port: number | undefined): void {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw imapConnectorError("port must be an integer between 1 and 65535.")
  }
}

function validateTimeout(field: string, timeout: number | undefined): void {
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1)) {
    throw imapConnectorError(`${field} must be a positive integer.`)
  }
}
