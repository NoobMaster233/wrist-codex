-- In-memory fixture: no native calls or filesystem writes are permitted.
local scenario = arg[1]
local source = arg[2]
local files, commands = {}, {}
local directory = "/data/files/dev.bandcodex.remote/"
local originalPrint = print
local callback
local windows = {
    [0x5f489c] = "f8b50d4d00af2c785cb9fff78bfe0126",
    [0x5f48e4] = "f8b5114d00af2c78c4b1104e30686bf7",
    [0xc84cbc] = "d8c7bf2c9d486b0c0000000001000000e8c7bf2ce5486b0c0000000001000000",
}
local function unhex(s) return s:gsub("..", function(h) return string.char(tonumber(h, 16)) end) end
if scenario == "old-marker" then files[directory .. "microphone-probe-attempted-v1"] = "old" end
io = {open = function(path, mode)
    if path == "/dev/ap" then
        local pos = 0
        return {seek = function(_, _, offset) pos = offset; return pos end,
            read = function(_, count)
                if scenario == "wrong-firmware" then return string.rep("x", count) end
                return unhex(assert(windows[pos]))
            end, close = function() end}
    end
    if mode:match("w") then files[path] = "" end
    if files[path] == nil then return nil, "absent" end
    return {read = function(_, count) return files[path]:sub(1, count) end,
        write = function(_, data) files[path] = files[path] .. data end, close = function() end}
end}
os = {time = function() return 123456789 end, execute = function(command)
    commands[#commands + 1] = command
    if command:match("^getprop") then files["/tmp/wrist-mic-version.txt"] = "3.101.043\n" end
    if command:match("^sh ") then
        if scenario == "no-watchdog" then return nil, "exit", 1 end
        files["/tmp/wrist-codex-mic-stop.state"] = "armed\n"
    end
    if command:match("^AT AT%^MIC_ENABLE=") then
        -- Alternate complete six-sample groups. Averaging preserves both signs.
        files["/tmp/wrist-codex-mic.pcm"] = string.rep(
            string.rep(string.char(0xe8, 0x03), 6) .. string.rep(string.char(0x18, 0xfc), 6), 4000)
    end
    if scenario == "capture-error" and command == "usleep 1000000" then error("injected wait error") end
    return true, "exit", 0
end}
local widget = {clear_flag = function() end, set = function() end}
local lvgl = {Object = function() return widget end, Label = function() return widget end,
    HOR_RES = function() return 336 end, VER_RES = function() return 480 end,
    OPA = function(x) return x end, Font = function() end,
    FLAG = {SCROLLABLE = 1}, ALIGN = {CENTER = 1}, Timer = function(options)
        callback = options.cb
        return {pause = function() end}
    end}
require = function(name) assert(name == "lvgl"); return lvgl end
assert(loadfile(source))()
callback()
if scenario == "reload" then assert(loadfile(source))(); callback() end
originalPrint(assert(files[directory .. "wrist-probe.json"]))
originalPrint(table.concat(commands, "|"))
originalPrint(files["/tmp/wrist-codex-mic-stop.sh"] or "NO WATCHDOG")
