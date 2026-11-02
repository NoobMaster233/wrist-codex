# Third-party components

The MIT license covers this project's original source code, custom digit
drawings, watchface Lua code and original visual assets.

Dependencies are obtained separately and retain their licenses:

| Component | Use | Upstream |
| --- | --- | --- |
| ws | Local Codex WebSocket client | https://github.com/websockets/ws |
| aiot-toolkit | Xiaomi Vela RPK build | https://www.npmjs.com/package/aiot-toolkit |
| Android SDK android.jar / R8 | Compile and dex phone-local byte pipes | https://developer.android.com/tools |
| libopus | Phone-side audio decoding | https://opus-codec.org/ |
| ARM GNU Toolchain | Build firmware-bound ET_REL modules | https://developer.arm.com/Tools%20and%20Software/GNU%20Toolchain |
| Lua / LVGL / Xiaomi Vela | Device-provided watchface runtime | https://iot.mi.com/vela/ |

SDK jars, toolchains, proprietary Xiaomi firmware and system fonts are not
redistributed. Native module binaries contain this project's compiled code
and firmware address bindings, not a copy of the firmware. MiSans-Regular
references the font already present on the device; no MiSans font file is shipped.

AstroBox, minstall and community reverse-engineering projects informed earlier
research. Daily operation does not require AstroBox, and their applications,
credentials and source trees are not bundled.

This project is unofficial and is not endorsed by Xiaomi or OpenAI.
