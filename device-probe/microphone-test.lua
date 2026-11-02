-- One capture experiment for the verified 3.101.043 firmware. No module
-- loading or firmware writes. A separate NSH task always sends STOP after 3s.
local lvgl = require("lvgl")
local directory = "/data/files/dev.bandcodex.remote/"
local reportPath = directory .. "microphone-probe.json"
local markerPath = directory .. "microphone-probe-attempted-v1"
local pcmPath = "/tmp/wrist-codex-mic.pcm"
local watchdogPath = "/tmp/wrist-codex-mic-stop.sh"
local watchdogState = "/tmp/wrist-codex-mic-stop.state"
local stopCommand = "AT AT^MIC_DISABLE="

local function read(path, count)
    local f = io.open(path, "rb")
    if not f then return nil end
    local data = f:read(count)
    f:close()
    return data or ""
end
local function write(path, data)
    local f, err = io.open(path, "w")
    if not f then error("write failed: " .. tostring(err)) end
    f:write(data); f:close()
end
local function quote(value)
    return '"' .. tostring(value):gsub('[%z\1-\31\\"]', function(c)
        return string.format('\\u%04x', c:byte())
    end) .. '"'
end
local function json(value)
    if type(value) == "boolean" or type(value) == "number" then return tostring(value) end
    if type(value) ~= "table" then return quote(value) end
    local parts = {}
    for k, v in pairs(value) do parts[#parts + 1] = quote(k) .. ":" .. json(v) end
    return "{" .. table.concat(parts, ",") .. "}"
end
local function command(text)
    local ok, _, code = os.execute(text)
    return ok == true and code == 0
end
local function verifyFirmware()
    local ap = assert(io.open("/dev/ap", "rb"), "AP partition is not readable")
    local windows = {
        {0x5f489c, "f8b50d4d00af2c785cb9fff78bfe0126"},
        {0x5f48e4, "f8b5114d00af2c78c4b1104e30686bf7"},
        {0xc84cbc, "d8c7bf2c9d486b0c0000000001000000e8c7bf2ce5486b0c0000000001000000"},
    }
    local matched = true
    for _, window in ipairs(windows) do
        if not ap:seek("set", window[1]) then matched = false; break end
        local data = ap:read(#window[2] / 2) or ""
        local hex = data:gsub(".", function(c) return string.format("%02x", c:byte()) end)
        if hex ~= window[2] then matched = false; break end
    end
    ap:close()
    assert(matched, "Microphone code does not match the verified firmware")
end
local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function base64(data)
    local parts = {}
    for i = 1, #data, 3 do
        local a, b, c = data:byte(i, i + 2)
        local n = a * 65536 + (b or 0) * 256 + (c or 0)
        local function ch(shift) local j = math.floor(n / 2^shift) % 64 + 1; return alphabet:sub(j, j) end
        parts[#parts + 1] = ch(18) .. ch(12) .. (b and ch(6) or "=") .. (c and ch(0) or "=")
    end
    return table.concat(parts)
end
local function mulaw(sample)
    local sign = sample < 0 and 128 or 0
    local value = math.min(math.abs(sample), 32635) + 132
    local exponent, mask = 7, 16384
    while exponent > 0 and value < mask do exponent = exponent - 1; mask = mask / 2 end
    local mantissa = math.floor(value / 2^(exponent + 3)) % 16
    return string.char(255 - sign - exponent * 16 - mantissa)
end
local function compactAudio(pcm)
    -- A small 8 kHz mu-law proof sample fits the existing report transport.
    -- Average six 48 kHz PCM samples, rather than dropping five of them.
    local bytes, peak, squares = {}, 0, 0
    local count = math.min(#pcm, 96000)
    count = count - count % 12
    for i = 1, count, 12 do
        local sum = 0
        for j = i, i + 10, 2 do
            local lo, hi = pcm:byte(j, j + 1)
            local sample = lo + hi * 256
            if sample >= 32768 then sample = sample - 65536 end
            peak = math.max(peak, math.abs(sample)); squares = squares + sample * sample
            sum = sum + sample
        end
        bytes[#bytes + 1] = mulaw(math.floor(sum / 6 + 0.5))
    end
    return table.concat(bytes), peak, count > 0 and math.sqrt(squares / (count / 2)) or 0
end

local root = lvgl.Object(nil, {w = lvgl.HOR_RES(), h = lvgl.VER_RES(),
    bg_color = 0x090f17, bg_opa = lvgl.OPA(100), border_width = 0})
root:clear_flag(lvgl.FLAG.SCROLLABLE)
local label = lvgl.Label(root, {text = "WRIST CODEX\n\nMICROPHONE TEST\nOne short sample\n\nChecking firmware...",
    text_color = 0x73e2c2, width = 300, height = 400,
    text_font = lvgl.Font("MiSans-Regular", 20), align = lvgl.ALIGN.CENTER})

local function inspect()
    command("mkdir -p " .. directory)
    local previous = read(reportPath, 30000)
    if previous then
        write(directory .. "wrist-probe.json", previous)
        label:set {text = "WRIST CODEX\n\nPrevious sample kept.\nNo new recording."}
        return
    end
    local info = {stage = "guard", attempted = false, captureFileProduced = false}
    local report = {schema = 1, probe = "wrist-codex-microphone-v1", time = tostring(os.time()),
        shell = true, results = {firmware = {output = "3.101.043"}, microphone = info}}
    local started = false
    local ok, err = pcall(function()
        assert(not read(markerPath, 32), "Previous attempt incomplete; refusing automatic recapture")
        assert(command("getprop ro.build.version > /tmp/wrist-mic-version.txt"), "Version query failed")
        assert((read("/tmp/wrist-mic-version.txt", 100) or ""):gsub("%s+$", "") == "3.101.043", "Unexpected firmware")
        verifyFirmware()
        info.firmwareWindowsMatched = true
        write(markerPath, tostring(os.time()))
        -- An empty state prevents a stale 'armed' marker from allowing capture.
        write(watchdogState, "")
        write(watchdogPath, "echo armed > " .. watchdogState .. "\nsleep 3\n" .. stopCommand ..
            "\necho stopped > " .. watchdogState .. "\n")
        info.stage = "watchdog"
        assert(command("sh " .. watchdogPath .. " &"), "Independent stop task could not start")
        command("usleep 50000")
        assert((read(watchdogState, 32) or ""):match("^armed"), "Independent stop task is not armed")
        info.watchdogArmed = true
        -- A private RAM path avoids touching existing user recording files.
        write(pcmPath, "")
        info.stage = "capture"
        started = true; info.attempted = true
        assert(command("AT AT^MIC_ENABLE=" .. pcmPath), "Microphone command could not be enqueued")
        command("usleep 1000000")
    end)
    -- This stop path runs even if capture raises an exception; the independent
    -- NSH task remains as a second stop path if the watchface is interrupted.
    if started then
        info.stopEnqueued = command(stopCommand)
        command("usleep 400000")
    end
    if not ok then info.error = tostring(err) end
    local pcm = read(pcmPath, 192001) or ""
    info.rawBytesObserved = #pcm
    if started and #pcm > 0 and #pcm <= 192000 and #pcm % 2 == 0 then
        local compact, peak, rms = compactAudio(pcm)
        info.captureFileProduced = #compact > 0
        info.codec = "mulaw"; info.sampleRate = 8000; info.channels = 1
        info.samples = #compact; info.audioBase64 = base64(compact)
        info.sourceSampleRate = 48000; info.sourceBits = 16
        info.sourcePeak = peak; info.sourceRms = rms
    end
    info.watchdogState = read(watchdogState, 32) or "unavailable"
    command("dmesg > /tmp/wrist-codex-mic-log.txt")
    local log = io.open("/tmp/wrist-codex-mic-log.txt", "rb")
    if log then
        local size = log:seek("end") or 0
        log:seek("set", math.max(0, size - 12000))
        local tail, lines = log:read(12000) or "", {}
        log:close()
        for line in tail:gmatch("[^\r\n]+") do
            if line:find("MIC_ENABLE", 1, true) or line:find("MIC_DISABLE", 1, true)
                or line:find("wrist-codex-mic", 1, true) then
                lines[#lines + 1] = line:sub(1, 240)
            end
        end
        info.nativeMicLog = table.concat(lines, "\n"):sub(-2400)
    end
    if ok then info.stage = "complete" end
    local body = json(report)
    assert(#body <= 30000, "Report exceeds the transport limit")
    write(reportPath, body); write(directory .. "wrist-probe.json", body)
    label:set {text = "WRIST CODEX\n\n" .. (info.captureFileProduced and "Audio sample saved." or "No audio sample yet.") ..
        "\nBytes: " .. tostring(info.rawBytesObserved) .. "\n\nOpen Codex to\ntransfer the report."}
end

local once = false
local timer
timer = lvgl.Timer {period = 700, cb = function()
    if once then return end
    once = true; timer:pause()
    local ok, err = pcall(inspect)
    if not ok then label:set {text = "Test error:\n" .. tostring(err)} end
end}
