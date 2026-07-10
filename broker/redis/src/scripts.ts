// Creates the metadata hash that represents an ensured broker stream.
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
  "createdAt", ARGV[3],
  "retainedBytes", "0"
)

if ARGV[4] ~= "" then
  redis.call("HSET", meta_key, "maxAgeMs", ARGV[4])
end

if ARGV[5] ~= "" then
  redis.call("HSET", meta_key, "maxRecords", ARGV[5])
end

if ARGV[6] ~= "" then
  redis.call("HSET", meta_key, "maxBytes", ARGV[6])
end

return 1
`

// Enforces age retention for idle streams and keeps exact encoded-body byte
// accounting in sync with the physical Redis Stream.
export const ENFORCE_AGE_RETENTION_SCRIPT = `
local stream_key = KEYS[1]
local meta_key = KEYS[2]

if redis.call("EXISTS", meta_key) == 0 then
  return redis.error_reply("broker stream has not been ensured")
end

local function entry_bytes(entry)
  local fields = entry[2]
  for index = 1, #fields, 2 do
    if fields[index] == "body" then
      return string.len(fields[index + 1])
    end
  end
  return 0
end

local function advance_boundary(candidate)
  if candidate then
    redis.call("HSET", meta_key, "lastTrimmedId", candidate)
  end
end

local max_age_ms = redis.call("HGET", meta_key, "maxAgeMs")
if not max_age_ms then
  return nil
end

local max_age_number = tonumber(max_age_ms)
local last_trimmed_id = nil
local removed_bytes = 0

if max_age_number <= 0 then
  local removed = redis.call("XREVRANGE", stream_key, "+", "-", "COUNT", 1)
  if #removed > 0 then
    last_trimmed_id = removed[1][1]
  end
  redis.call("XTRIM", stream_key, "MAXLEN", "=", "0")
  redis.call("HSET", meta_key, "retainedBytes", "0")
else
  local now = redis.call("TIME")
  local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
  local min_ms = math.max(0, now_ms - max_age_number)
  local min_id = tostring(min_ms) .. "-0"
  local start = "-"

  while true do
    local entries = redis.call("XRANGE", stream_key, start, "(" .. min_id, "COUNT", 256)
    if #entries == 0 then
      break
    end
    for index = 1, #entries do
      removed_bytes = removed_bytes + entry_bytes(entries[index])
      last_trimmed_id = entries[index][1]
    end
    start = "(" .. entries[#entries][1]
    if #entries < 256 then
      break
    end
  end

  redis.call("XTRIM", stream_key, "MINID", "=", min_id)
  local retained = math.max(0, tonumber(redis.call("HGET", meta_key, "retainedBytes") or "0") - removed_bytes)
  redis.call("HSET", meta_key, "retainedBytes", tostring(retained))
end

advance_boundary(last_trimmed_id)
return last_trimmed_id
`

// Trims physical retained history after append so blocked XREAD subscribers can
// first observe the complete live batch.
export const TRIM_STREAM_RETENTION_SCRIPT = `
local stream_key = KEYS[1]
local meta_key = KEYS[2]

if redis.call("EXISTS", meta_key) == 0 then
  return redis.error_reply("broker stream has not been ensured")
end

local function entry_bytes(entry)
  local fields = entry[2]
  for index = 1, #fields, 2 do
    if fields[index] == "body" then
      return string.len(fields[index + 1])
    end
  end
  return 0
end

local last_trimmed_id = nil
local retained_bytes = tonumber(redis.call("HGET", meta_key, "retainedBytes") or "0")

local function record_removed(entries)
  for index = 1, #entries do
    retained_bytes = math.max(0, retained_bytes - entry_bytes(entries[index]))
    last_trimmed_id = entries[index][1]
  end
end

local function scan_prefix(count)
  local remaining = count
  local start = "-"
  while remaining > 0 do
    local page_size = math.min(remaining, 256)
    local entries = redis.call("XRANGE", stream_key, start, "+", "COUNT", page_size)
    if #entries == 0 then
      break
    end
    record_removed(entries)
    remaining = remaining - #entries
    start = "(" .. entries[#entries][1]
  end
end

local max_records = redis.call("HGET", meta_key, "maxRecords")
if max_records then
  local max_records_number = tonumber(max_records)
  local remove_count = redis.call("XLEN", stream_key) - max_records_number
  if remove_count > 0 then
    scan_prefix(remove_count)
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
    retained_bytes = 0
  else
    local now = redis.call("TIME")
    local now_ms = (tonumber(now[1]) * 1000) + math.floor(tonumber(now[2]) / 1000)
    local min_id = tostring(math.max(0, now_ms - max_age_number)) .. "-0"
    local start = "-"
    while true do
      local entries = redis.call("XRANGE", stream_key, start, "(" .. min_id, "COUNT", 256)
      if #entries == 0 then
        break
      end
      record_removed(entries)
      start = "(" .. entries[#entries][1]
      if #entries < 256 then
        break
      end
    end
    redis.call("XTRIM", stream_key, "MINID", "=", min_id)
  end
end

local max_bytes = redis.call("HGET", meta_key, "maxBytes")
if max_bytes then
  local max_bytes_number = tonumber(max_bytes)
  if max_bytes_number <= 0 then
    local removed = redis.call("XREVRANGE", stream_key, "+", "-", "COUNT", 1)
    if #removed > 0 then
      last_trimmed_id = removed[1][1]
    end
    redis.call("XTRIM", stream_key, "MAXLEN", "=", "0")
    retained_bytes = 0
  else
    while retained_bytes > max_bytes_number do
      local entries = redis.call("XRANGE", stream_key, "-", "+", "COUNT", 256)
      if #entries == 0 then
        retained_bytes = 0
        break
      end
      local ids = {}
      for index = 1, #entries do
        if retained_bytes <= max_bytes_number then
          break
        end
        retained_bytes = math.max(0, retained_bytes - entry_bytes(entries[index]))
        last_trimmed_id = entries[index][1]
        ids[#ids + 1] = entries[index][1]
      end
      if #ids > 0 then
        redis.call("XDEL", stream_key, unpack(ids))
      else
        break
      end
    end
  end
end

redis.call("HSET", meta_key, "retainedBytes", tostring(retained_bytes))
if last_trimmed_id then
  redis.call("HSET", meta_key, "lastTrimmedId", last_trimmed_id)
end
return last_trimmed_id
`

// Appends a batch atomically. Physical trimming follows separately; this script
// records the logical retained boundary so concurrent reads cannot observe data
// beyond maxRecords/maxBytes in the interim.
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

local function entry_bytes(entry)
  local fields = entry[2]
  for index = 1, #fields, 2 do
    if fields[index] == "body" then
      return string.len(fields[index + 1])
    end
  end
  return 0
end

local function id_is_newer(candidate, current)
  if not current then
    return true
  end
  local candidate_ms, candidate_seq = string.match(candidate, "^(%d+)%-(%d+)$")
  local current_ms, current_seq = string.match(current, "^(%d+)%-(%d+)$")
  candidate_ms = tonumber(candidate_ms)
  candidate_seq = tonumber(candidate_seq)
  current_ms = tonumber(current_ms)
  current_seq = tonumber(current_seq)
  return candidate_ms > current_ms or (candidate_ms == current_ms and candidate_seq > current_seq)
end

local function advance_boundary(candidate)
  local current = redis.call("HGET", meta_key, "lastTrimmedId")
  if candidate and id_is_newer(candidate, current) then
    redis.call("HSET", meta_key, "lastTrimmedId", candidate)
  end
end

local replies = {}
local stored_count = 0
local last_stored_id = nil

for index = 1, record_count do
  local dedupe_key = KEYS[index + 2]
  local arg_index = 3 + ((index - 1) * 2)
  local body = ARGV[arg_index]
  local has_idempotency_key = ARGV[arg_index + 1]
  local existing_id = nil

  if has_idempotency_key == "1" then
    existing_id = redis.call("GET", dedupe_key)
  end

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
    if has_idempotency_key == "1" then
      redis.call("SET", dedupe_key, id, "PX", dedupe_ttl_ms)
    end
    redis.call("HINCRBY", meta_key, "retainedBytes", string.len(body))
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
  local remove_count = redis.call("XLEN", stream_key) - tonumber(max_records)
  if remove_count > 0 then
    local removed = redis.call("XRANGE", stream_key, "-", "+", "COUNT", remove_count)
    if #removed > 0 then
      advance_boundary(removed[#removed][1])
    end
  end
end

local max_bytes = redis.call("HGET", meta_key, "maxBytes")
local retained_bytes = tonumber(redis.call("HGET", meta_key, "retainedBytes") or "0")
if max_bytes and retained_bytes > tonumber(max_bytes) then
  local target = tonumber(max_bytes)
  local remaining = retained_bytes
  local start = "-"
  local boundary = nil
  while remaining > target do
    local entries = redis.call("XRANGE", stream_key, start, "+", "COUNT", 256)
    if #entries == 0 then
      break
    end
    for index = 1, #entries do
      if remaining <= target then
        break
      end
      remaining = math.max(0, remaining - entry_bytes(entries[index]))
      boundary = entries[index][1]
    end
    start = "(" .. entries[#entries][1]
  end
  advance_boundary(boundary)
end

return replies
`
