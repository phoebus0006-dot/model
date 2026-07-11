export const CREATE_JOB_LUA = `
  local job_key = KEYS[1]
  local index_key = KEYS[2]
  local job_json = ARGV[1]
  local score = tonumber(ARGV[2])
  local job_id = ARGV[3]

  redis.call("SET", job_key, job_json)
  redis.call("ZADD", index_key, score, job_id)

  return 1
`;

export const CLAIM_JOB_LUA = `
  local index_key = KEYS[1]
  local max_count = tonumber(ARGV[1])
  local runner = ARGV[2]
  local worker_id = ARGV[3]
  local now_ms = tonumber(ARGV[4])
  local iso_now = ARGV[5]

  local ids = redis.call("ZREVRANGE", index_key, 0, 500)
  local claimed = {}
  local claimed_count = 0

  for i, id in ipairs(ids) do
    if claimed_count >= max_count then break end

    local job_key = "crawler:job:" .. id
    local raw = redis.call("GET", job_key)
    if not raw then
    else
      local ok, job = pcall(cjson.decode, raw)
      if ok then
        local can_claim = false

        if (job["status"] == "queued" or job["status"] == "deferred") and job["runner"] == runner then
          can_claim = true
          local nb = job["notBeforeMs"]
          if nb and tonumber(nb) and tonumber(nb) > now_ms then
            can_claim = false
          end
        end

        local attempts = job["attempts"] or 0
        local maxAttempts = job["maxAttempts"] or 3
        if can_claim and attempts >= maxAttempts then
          can_claim = false
        end

        if can_claim then
          job["status"] = "claimed"
          job["workerId"] = worker_id
          job["attempts"] = attempts + 1
          job["claimedAt"] = iso_now
          job["updatedAt"] = iso_now

          redis.call("SET", job_key, cjson.encode(job))
          table.insert(claimed, cjson.encode(job))
          claimed_count = claimed_count + 1
        end
      end
    end
  end

  return claimed
`;
