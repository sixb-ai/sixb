import type { ReadonlyJsonValue } from "../json"

const REDACTED = "[REDACTED]"
const MAX_CONTEXT_DEPTH = 12
const MAX_CONTEXT_ENTRIES = 1024
const SENSITIVE_KEY =
  /password|passwd|passphrase|secret|token|credential|authorization|cookie|privatekey|apikey|accesskey|connectionstring|databaseurl|clientassertion|signature/i
const PRIVATE_CONTAINER =
  /^(?:request|response)(?:body|headers)?$|^(?:headers|body|payload|env|environment)$/i

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "")
  return SENSITIVE_KEY.test(normalized) || PRIVATE_CONTAINER.test(normalized)
}

/** Runtime credentials are additional protection for context; never a license to copy errors. */
function environmentSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => isSensitiveKey(key) && value !== undefined && value.length >= 4)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length)
}

export function createFailureRedactor() {
  const secrets = environmentSecrets()
  let redacted = false
  let truncated = false
  let entries = 0

  const text = (input: string): string => {
    let value = input
    for (const secret of secrets) {
      value = value
        .split(REDACTED)
        .map((part) => part.split(secret).join(REDACTED))
        .join(REDACTED)
    }
    value = value
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
        REDACTED
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.~=-]+/gi, REDACTED)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
      .replace(
        /\b(?:sk[-_](?:live[-_]|test[-_]|proj[-_])?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g,
        REDACTED
      )
      // URLs may carry userinfo, signed query parameters, or credentials in the path.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, REDACTED)
      .replace(
        /["']?\b(?:password|passwd|passphrase|[a-z_-]*secret|[a-z_-]*token|api[-_]?key|authorization|cookie|credential|signature)["']?\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
        REDACTED
      )
    if (value !== input) redacted = true
    return value
  }

  const context = (value: ReadonlyJsonValue, depth = 0): ReadonlyJsonValue => {
    if (depth > MAX_CONTEXT_DEPTH || entries++ >= MAX_CONTEXT_ENTRIES) {
      truncated = true
      return "[TRUNCATED]"
    }
    if (typeof value === "string") return text(value)
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) {
      const available = Math.max(0, MAX_CONTEXT_ENTRIES - entries)
      if (value.length > available) truncated = true
      return value.slice(0, available).map((entry) => context(entry, depth + 1))
    }
    const result: Record<string, ReadonlyJsonValue> = Object.create(null)
    for (const [key, entry] of Object.entries(value)) {
      if (entries >= MAX_CONTEXT_ENTRIES) {
        truncated = true
        break
      }
      if (isSensitiveKey(key)) {
        redacted = true
        entries++
        result[text(key)] = REDACTED
      } else {
        result[text(key)] = context(entry, depth + 1)
      }
    }
    return result
  }

  return {
    text,
    context,
    get redacted() {
      return redacted
    },
    get truncated() {
      return truncated
    },
  }
}
