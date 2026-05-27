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

// Trims retained append history after appends have committed. This is separate
// from APPEND_RECORDS_SCRIPT so blocked XREAD subscribers can be woken with the
// full live batch before retained history is reduced to its configured window.
export const TRIM_STREAM_RETENTION_SCRIPT = `
local stream_key = KEYS[1]
local meta_key = KEYS[2]

if redis.call("EXISTS", meta_key) == 0 then
  return redis.error_reply("broker stream has not been ensured")
end

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

return last_trimmed_id
`

// Appends a batch of broker records with one Redis round trip. Each record still
// gets its own stream id and idempotency decision.
//
// KEYS:
//   1: stream key
//   2: metadata key
//   3..N: per-record dedupe keys, using a placeholder key when the record has no idempotency key
// ARGV:
//   1: dedupe ttl ms
//   2: record count
//   3..N: repeated pairs of { body, has idempotency key: "1" | "0" }
export const APPEND_RECORDS_SCRIPT = `
local stream_key = KEYS[1]
local meta_key = KEYS[2]
local dedupe_ttl_ms = ARGV[1]
local record_count = tonumber(ARGV[2])

if redis.call("EXISTS", meta_key) == 0 then
  return redis.error_reply("broker stream has not been ensured")
end

if not record_count then
  return redis.error_reply("invalid broker record count")
end

if (#KEYS - 2) ~= record_count then
  return redis.error_reply("dedupe key count does not match broker record count")
end

local replies = {}
local stored_count = 0
local last_stored_id = nil

for i = 1, record_count do
  local dedupe_key = KEYS[i + 2]
  local arg_index = 3 + ((i - 1) * 2)
  local body = ARGV[arg_index]
  local has_idempotency_key = ARGV[arg_index + 1]

  if has_idempotency_key == "1" then
    local existing_id = redis.call("GET", dedupe_key)
    if existing_id then
      local existing_body = ""
      local existing_entries = redis.call("XRANGE", stream_key, existing_id, existing_id, "COUNT", 1)
      if #existing_entries > 0 then
        local fields = existing_entries[1][2]
        for field_index = 1, #fields, 2 do
          if fields[field_index] == "body" then
            existing_body = fields[field_index + 1]
            break
          end
        end
      end
      replies[#replies + 1] = { "duplicate", existing_id, existing_body }
    else
      local id = redis.call("XADD", stream_key, "*", "body", body)
      redis.call("SET", dedupe_key, id, "PX", dedupe_ttl_ms)
      replies[#replies + 1] = { "stored", id, "" }
      stored_count = stored_count + 1
      last_stored_id = id
    end
  else
    local id = redis.call("XADD", stream_key, "*", "body", body)
    replies[#replies + 1] = { "stored", id, "" }
    stored_count = stored_count + 1
    last_stored_id = id
  end
end

if stored_count == 0 then
  return replies
end

redis.call("HSET", meta_key, "lastId", last_stored_id)

local max_records = redis.call("HGET", meta_key, "maxRecords")

if max_records then
  -- Mark the retained boundary atomically with append so retained reads do not
  -- observe entries beyond maxRecords while physical XTRIM is deferred for live
  -- XREAD delivery.
  local max_records_number = tonumber(max_records)
  local length = redis.call("XLEN", stream_key)
  local remove_count = length - max_records_number

  if remove_count > 0 then
    local removed = redis.call("XRANGE", stream_key, "-", "+", "COUNT", remove_count)
    if #removed > 0 then
      redis.call("HSET", meta_key, "lastTrimmedId", removed[#removed][1])
    end
  end
end

return replies
`
