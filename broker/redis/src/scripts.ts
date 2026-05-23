// Creates the metadata hash that represents an ensured broker stream.
// Redis Stream keys are born on first XADD, so metadata lets us distinguish an
// empty ensured stream from one that has never been provisioned.
export const ENSURE_STREAM_SCRIPT = `
local meta_key = KEYS[1]

if redis.call("EXISTS", meta_key) == 1 then
  return 0
end

redis.call(
  "HSET",
  meta_key,
  "projectId", ARGV[1],
  "streamId", ARGV[2],
  "createdAt", ARGV[3]
)

if ARGV[4] ~= "" then
  redis.call("HSET", meta_key, "maxAgeMs", ARGV[4])
end

if ARGV[5] ~= "" then
  redis.call("HSET", meta_key, "maxRecords", ARGV[5])
end

return 1
`

// Enforces age-based retention without appending. Redis Streams do not have a
// background TTL policy for entries, so idle streams need this before retained
// reads/replays to avoid returning expired records.
export const ENFORCE_AGE_RETENTION_SCRIPT = `
local stream_key = KEYS[1]
local meta_key = KEYS[2]

if redis.call("EXISTS", meta_key) == 0 then
  return redis.error_reply("broker stream has not been ensured")
end

local max_age_ms = redis.call("HGET", meta_key, "maxAgeMs")

if not max_age_ms then
  return nil
end

local max_age_number = tonumber(max_age_ms)
local last_trimmed_id = nil

if max_age_number <= 0 then
  local removed = redis.call("XREVRANGE", stream_key, "+", "-", "COUNT", 1)
  if #removed > 0 then
    last_trimmed_id = removed[1][1]
  end
  redis.call("XTRIM", stream_key, "MAXLEN", "=", "0")
else
  local now = redis.call("TIME")
  local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
  local min_ms = now_ms - max_age_number
  if min_ms < 0 then
    min_ms = 0
  end
  local min_id = tostring(min_ms) .. "-0"
  local removed = redis.call("XREVRANGE", stream_key, "(" .. min_id, "-", "COUNT", 1)
  if #removed > 0 then
    last_trimmed_id = removed[1][1]
  end
  redis.call("XTRIM", stream_key, "MINID", "=", min_id)
end

if last_trimmed_id then
  redis.call("HSET", meta_key, "lastTrimmedId", last_trimmed_id)
end

return last_trimmed_id
`

// Appends exactly one broker record. Keep this operation in Lua so the returned
// cursor, dedupe key, retention trim, and retained-range metadata cannot drift
// apart if another process writes to the same Redis stream concurrently.
export const APPEND_RECORD_SCRIPT = `
local stream_key = KEYS[1]
local meta_key = KEYS[2]
local dedupe_key = KEYS[3]
local body = ARGV[1]
local has_idempotency_key = ARGV[2]
local dedupe_ttl_ms = ARGV[3]

if redis.call("EXISTS", meta_key) == 0 then
  return redis.error_reply("broker stream has not been ensured")
end

if has_idempotency_key == "1" then
  local existing_id = redis.call("GET", dedupe_key)
  if existing_id then
    return { "duplicate", existing_id }
  end
end

local id = redis.call("XADD", stream_key, "*", "body", body)
redis.call("HSET", meta_key, "lastId", id)

local last_trimmed_id = nil
local max_records = redis.call("HGET", meta_key, "maxRecords")

if max_records then
  -- Exact trimming is deliberate: the broker contract needs deterministic
  -- retained-range behavior so callers know when recovery is required.
  local max_records_number = tonumber(max_records)
  local length = redis.call("XLEN", stream_key)
  local remove_count = length - max_records_number

  if remove_count > 0 then
    local removed = redis.call("XRANGE", stream_key, "-", "+", "COUNT", remove_count)
    if #removed > 0 then
      last_trimmed_id = removed[#removed][1]
    end
    redis.call("XTRIM", stream_key, "MAXLEN", "=", max_records)
  end
end

local max_age_ms = redis.call("HGET", meta_key, "maxAgeMs")

if max_age_ms then
  local max_age_number = tonumber(max_age_ms)

  if max_age_number <= 0 then
    local removed = redis.call("XREVRANGE", stream_key, "+", "-", "COUNT", 1)
    if #removed > 0 then
      last_trimmed_id = removed[1][1]
    end
    redis.call("XTRIM", stream_key, "MAXLEN", "=", "0")
  else
    local now = redis.call("TIME")
    local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
    local min_ms = now_ms - max_age_number
    if min_ms < 0 then
      min_ms = 0
    end
    local min_id = tostring(min_ms) .. "-0"
    -- Capture the newest entry that will be removed by MINID before trimming.
    -- Later reads compare cursors to this boundary instead of guessing from the
    -- first retained id, which is unsafe because Redis ids are not dense.
    local removed = redis.call("XREVRANGE", stream_key, "(" .. min_id, "-", "COUNT", 1)
    if #removed > 0 then
      last_trimmed_id = removed[1][1]
    end
    redis.call("XTRIM", stream_key, "MINID", "=", min_id)
  end
end

if last_trimmed_id then
  redis.call("HSET", meta_key, "lastTrimmedId", last_trimmed_id)
end

if has_idempotency_key == "1" then
  redis.call("SET", dedupe_key, id, "PX", dedupe_ttl_ms)
end

return { "stored", id }
`
