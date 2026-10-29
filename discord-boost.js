// Discord Linux Boost & Auto-Patcher (Wayland / PipeWire / NVENC / Stereo Opus / XWayland Hotkeys)
// Repository: https://github.com/ArenaMMORPG/discord-linux-boost
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const HOME = os.homedir();
const DISCORD_CONFIG_DIR = path.join(HOME, ".config", "discord");
const WIREPLUMBER_PROPS = path.join(HOME, ".local", "state", "wireplumber", "stream-properties");
const SPEECHD_CONF_DIR = path.join(HOME, ".config", "speech-dispatcher");
const SPEECHD_CONF = path.join(SPEECHD_CONF_DIR, "speechd.conf");
const KGLOBALSHORTCUTS_RC = path.join(HOME, ".config", "kglobalshortcutsrc");

function log(...args) {
    console.log("[DiscordBoost]", ...args);
}

// 1. Ensure WirePlumber never mutes discord_capture (fixes 0% / muted stream audio on PipeWire)
function fixWirePlumberMute() {
    try {
        if (fs.existsSync(WIREPLUMBER_PROPS)) {
            const content = fs.readFileSync(WIREPLUMBER_PROPS, "utf8");
            if (content.includes("discord_capture") && content.includes('"mute":true')) {
                const updated = content.replace(
                    /(Input\/Audio:application\.name:discord_capture=\{[^\n]*?)"mute":true/g,
                    '$1"mute":false'
                );
                if (updated !== content) {
                    fs.writeFileSync(WIREPLUMBER_PROPS, updated, "utf8");
                    log("Unmuted discord_capture in WirePlumber stream-properties");
                }
            }
        }
    } catch (e) {
        console.warn("[DiscordBoost] WirePlumber check error:", e.message);
    }
}

// Also unmute any currently active discord_capture source-outputs in live PipeWire/PulseAudio
function unmuteLiveDiscordCapture() {
    try {
        execFile("pactl", ["list", "source-outputs"], { timeout: 3000 }, (err, stdout) => {
            if (err || !stdout) return;
            const blocks = stdout.split("Source Output #");
            for (const block of blocks) {
                if (!block.includes('application.name = "discord_capture"')) continue;
                const idMatch = block.match(/^(\d+)/);
                if (!idMatch) continue;
                const id = idMatch[1];
                if (block.includes("Mute: yes")) {
                    execFile("pactl", ["set-source-output-mute", id, "0"], () => {});
                    execFile("pactl", ["set-source-output-volume", id, "100%"], () => {});
                    log("Unmuted live discord_capture Source Output #" + id);
                }
            }
        });
    } catch (e) {}
}

// Prevent speech-dispatcher dummy stream (sd_dummy) from blocking PulseAudioController mixer
function fixSpeechDispatcherDummy() {
    try {
        if (!fs.existsSync(SPEECHD_CONF) || !fs.readFileSync(SPEECHD_CONF, "utf8").includes("DisableAutoSpawn")) {
            fs.mkdirSync(SPEECHD_CONF_DIR, { recursive: true });
            fs.writeFileSync(SPEECHD_CONF, "DisableAutoSpawn\n", "utf8");
            log("Disabled speech-dispatcher auto-spawn in", SPEECHD_CONF);
        }
    } catch (e) {}
}

// Clean up any stale KDE GlobalShortcuts portal registrations for Discord so kglobalacceld
// does not intercept keys (like F19 / Numpad*) or show portal conflict warnings
function cleanKdeDiscordPortalShortcuts() {
    try {
        if (fs.existsSync(KGLOBALSHORTCUTS_RC)) {
            const content = fs.readFileSync(KGLOBALSHORTCUTS_RC, "utf8");
            if (content.includes("[discord]")) {
                const updated = content.replace(/\[discord\][\s\S]*?(?=\n\[|$)\n?/, "");
                if (updated !== content) {
                    fs.writeFileSync(KGLOBALSHORTCUTS_RC, updated, "utf8");
                    log("Removed stale [discord] portal section from kglobalshortcutsrc");
                }
            }
        }
        for (const qdbusBin of ["qdbus6", "qdbus"]) {
            execFile(
                qdbusBin,
                ["org.kde.kglobalaccel", "/component/discord", "org.kde.kglobalaccel.Component.shortcutNames"],
                { timeout: 2000 },
                (err, stdout) => {
                    if (err || !stdout) return;
                    const names = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                    for (const name of names) {
                        execFile(
                            qdbusBin,
                            ["org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel.unregister", "discord", name],
                            { timeout: 2000 },
                            () => {}
                        );
                    }
                    if (names.length > 0) {
                        execFile(
                            qdbusBin,
                            ["org.kde.kglobalaccel", "/component/discord", "org.kde.kglobalaccel.Component.cleanUp"],
                            { timeout: 2000 },
                            () => {}
                        );
                        log("Unregistered stale KDE global shortcuts:", names.join(", "));
                    }
                }
            );
        }
    } catch (e) {}
}

// 2. Relocation-independent binary patcher for PulseAudioController in discord_voice.node:
// - MonitorSinkInput(): replaces pa_stream_connect_record(stream, NULL, NULL, 0) with
//   pa_buffer_attr { maxlength=-1, tlength=-1, prebuf=-1, minreq=-1, fragsize=1920 (10ms) }
//   and flags = PA_STREAM_ADJUST_LATENCY (0x2000).
// - SinkIdentified(): bypasses strict single-PID filter (75 14 -> 90 90) so child/container/Proton
//   audio streams are captured (while still excluding Discord's own getpid()).
const VOICE_MONITOR_ANCHOR = Buffer.from("4c89f731f631d231c9e8", "hex");
const VOICE_MONITOR_PATCHED_ANCHOR = Buffer.from("4c89f731f6488d151b000000b900200000e8", "hex");
const VOICE_PID_ANCHOR = Buffer.from("8b838002000083f801", "hex");
const VOICE_READ_AVAIL_ORIG = Buffer.from(
    "498b4424288b4010418b8e08f1020029c84801c089d94839c80f43c389c3ebb3",
    "hex"
);

function findVoiceMonitorOffset(buf) {
    let pos = 0;
    while ((pos = buf.indexOf(VOICE_MONITOR_ANCHOR, pos)) !== -1) {
        if (buf[pos + 14] === 0x85 && buf[pos + 15] === 0xc0 && buf[pos + 16] === 0x78) {
            return pos;
        }
        pos++;
    }
    return -1;
}

function findVoicePidOffset(buf) {
    let pos = 0;
    while ((pos = buf.indexOf(VOICE_PID_ANCHOR, pos)) !== -1) {
        if (buf[pos + 11] === 0xe8 && buf[pos + 16] === 0x44 && buf[pos + 17] === 0x39 && buf[pos + 18] === 0xf8) {
            return pos;
        }
        pos++;
    }
    return -1;
}

function patchDiscordVoiceBinary(nodePath) {
    try {
        if (!fs.existsSync(nodePath)) return false;
        const backupPath = nodePath + ".orig";
        let buf = fs.readFileSync(nodePath);
        let modified = false;

        // Restore from .orig if an older experimental ReadAvailable patch was present
        if (buf.indexOf(VOICE_READ_AVAIL_ORIG) === -1 && fs.existsSync(backupPath)) {
            buf = fs.readFileSync(backupPath);
            modified = true;
        }

        const monitorIdx = findVoiceMonitorOffset(buf);
        const alreadyMonitorPatched = buf.indexOf(VOICE_MONITOR_PATCHED_ANCHOR) !== -1;

        if (monitorIdx !== -1) {
            if (!fs.existsSync(backupPath)) {
                fs.copyFileSync(nodePath, backupPath);
            }
            // Dynamically compute relocated call pa_stream_connect_record@plt and js offsets (-8 bytes shift)
            const origCallRel32 = buf.readInt32LE(monitorIdx + 10);
            const origJsRel8 = buf.readInt8(monitorIdx + 17);
            const newCallRel32 = origCallRel32 - 8;
            const newJsRel8 = origJsRel8 - 8;

            const patchBuf = Buffer.alloc(60, 0x90);
            // mov %r14,%rdi; xor %esi,%esi; lea 0x1b(%rip),%rdx; mov $0x2000,%ecx; call <pa_stream_connect_record>
            Buffer.from("4c89f731f6488d151b000000b900200000e8", "hex").copy(patchBuf, 0);
            patchBuf.writeInt32LE(newCallRel32, 18);
            // test %eax,%eax; js <error_branch>; jmp +0x20 (to instruction at +60)
            patchBuf[22] = 0x85;
            patchBuf[23] = 0xc0;
            patchBuf[24] = 0x78;
            patchBuf.writeInt8(newJsRel8, 25);
            patchBuf[26] = 0xeb;
            patchBuf[27] = 0x20;
            // Embedded pa_buffer_attr at offset +39: { maxlength=-1, tlength=-1, prebuf=-1, minreq=-1, fragsize=1920 }
            Buffer.from("ffffffffffffffffffffffffffffffff80070000", "hex").copy(patchBuf, 39);

            patchBuf.copy(buf, monitorIdx);
            modified = true;
        } else if (!alreadyMonitorPatched) {
            return false;
        }

        const pidIdx = findVoicePidOffset(buf);
        if (pidIdx !== -1 && (buf[pidIdx + 9] !== 0x90 || buf[pidIdx + 10] !== 0x90)) {
            if (!fs.existsSync(backupPath)) {
                fs.copyFileSync(nodePath, backupPath);
            }
            buf[pidIdx + 9] = 0x90;
            buf[pidIdx + 10] = 0x90;
            modified = true;
        }

        if (!modified) {
            return false;
        }

        const tmpPath = nodePath + ".boost_tmp";
        fs.writeFileSync(tmpPath, buf, { mode: 0o755 });
        fs.renameSync(tmpPath, nodePath);
        log("Patched PulseAudioController (MonitorSinkInput 10ms fragsize + SinkIdentified PID bypass) in", nodePath);
        return true;
    } catch (e) {
        console.warn("[DiscordBoost] Binary patch error:", e.message);
        return false;
    }
}

// 3. Patch discord_voice/index.js for Stereo 160kbps Opus & 12Mbps NVENC Stream Bitrate
const VOICE_JS_MARKER = "/* [DiscordBoost:TransportOptions:v4] */";
const VOICE_JS_TARGET = "setTransportOptions: (options) => instance.setTransportOptions(options),";
const VOICE_JS_REPLACEMENT = `setTransportOptions: (options) => { ${VOICE_JS_MARKER}
            try {
                if (options && typeof options === 'object') {
                    if (options.audioEncoder && typeof options.audioEncoder === 'object') {
                        options.audioEncoder.channels = 2;
                        if (!options.audioEncoder.rate || options.audioEncoder.rate < 160000) {
                            options.audioEncoder.rate = 160000;
                        }
                    }
                    if (options.encodingVoiceBitRate && options.encodingVoiceBitRate < 160000) {
                        options.encodingVoiceBitRate = 160000;
                    }
                    // Boost video bitrate ONLY when WE are actively sending an outgoing video stream
                    // (streamParameters[].active === true). Never touch viewer-only stream connections
                    // (where streamParameters[].active === false).
                    const isActivelySendingVideo = !Array.isArray(options.streamParameters) ||
                        options.streamParameters.some((s) => s && s.active === true);
                    if (isActivelySendingVideo && (options.encodingVideoBitRate || options.encodingVideoMaxBitRate)) {
                        if (options.encodingVideoMinBitRate && options.encodingVideoMinBitRate < 4000000) {
                            options.encodingVideoMinBitRate = 4000000;
                        }
                        if (options.encodingVideoBitRate && options.encodingVideoBitRate < 10000000) {
                            options.encodingVideoBitRate = 10000000;
                        }
                        if (options.encodingVideoMaxBitRate && options.encodingVideoMaxBitRate < 12000000) {
                            options.encodingVideoMaxBitRate = 12000000;
                        }
                        if (Array.isArray(options.streamParameters)) {
                            for (const sp of options.streamParameters) {
                                if (sp && sp.active === true && sp.type === 'video') {
                                    if (sp.minBitrate && sp.minBitrate < 4000000) sp.minBitrate = 4000000;
                                    if (sp.targetBitrate && sp.targetBitrate < 10000000) sp.targetBitrate = 10000000;
                                    if (sp.maxBitrate && sp.maxBitrate < 12000000) sp.maxBitrate = 12000000;
                                }
                            }
                        }
                    }
                }
            } catch (err) {}
            return instance.setTransportOptions(options);
        },`;

function patchDiscordVoiceJs(jsPath) {
    try {
        if (!fs.existsSync(jsPath)) return false;
        const content = fs.readFileSync(jsPath, "utf8");
        if (content.includes(VOICE_JS_MARKER)) {
            return false; // Already patched with v4
        }
        let updated = content;
        if (content.includes("/* [DiscordBoost:TransportOptions")) {
            updated = content.replace(
                /setTransportOptions:\s*\(options\)\s*=>\s*\{\s*\/\*\s*\[DiscordBoost:TransportOptions[^\]]*\][\s\S]*?return instance\.setTransportOptions\(options\);\s*\},/,
                VOICE_JS_REPLACEMENT
            );
        } else if (content.includes(VOICE_JS_TARGET)) {
            updated = content.replace(VOICE_JS_TARGET, VOICE_JS_REPLACEMENT);
        } else {
            return false;
        }

        if (updated !== content) {
            fs.writeFileSync(jsPath, updated, "utf8");
            log("Patched Stereo 160kbps Opus & 12Mbps video transport options (v4) in", jsPath);
            return true;
        }
        return false;
    } catch (e) {
        console.warn("[DiscordBoost] JS patch error:", e.message);
        return false;
    }
}

// 4. Relocation-independent binary patcher for discord_utils.node + JS patcher for input_capture.js:
// Forces InputEvents::PlatformInitialize() to jump straight to the X11/XInput2 initialization block
// instead of WaylandGlobalShortcuts portal. This keeps sWaylandShortcuts == NULL so:
// - IsWaylandGlobalShortcutsAvailable() returns false (no yellow warning banner in Keybinds settings)
// - KDE's "Global Shortcuts Requested" modal NEVER pops up
// - Numpad*, F19, UNK197, mouse buttons, and multi-key combos work directly via XWayland
const UTILS_WAYLAND_ANCHOR = Buffer.from("ba070000004889c7e8", "hex");

function patchDiscordUtilsBinary(nodePath) {
    try {
        if (!fs.existsSync(nodePath)) return false;
        const buf = fs.readFileSync(nodePath);

        let pos = 0;
        let matchPos = -1;
        while ((pos = buf.indexOf(UTILS_WAYLAND_ANCHOR, pos)) !== -1) {
            if (
                buf[pos + 13] === 0x85 &&
                buf[pos + 14] === 0xc0 &&
                buf[pos + 29] === 0x48 &&
                buf[pos + 30] === 0x85 &&
                buf[pos + 31] === 0xc0
            ) {
                matchPos = pos;
                break;
            }
            pos++;
        }

        if (matchPos === -1) return false;

        const entryPos = matchPos - 0x18;
        // Check if already patched
        if (
            buf[entryPos] === 0xe9 &&
            buf[matchPos + 15] === 0x90 &&
            buf[matchPos + 16] === 0x90 &&
            buf[matchPos + 32] === 0x90 &&
            buf[matchPos + 33] === 0xe9
        ) {
            return false;
        }

        // Read the X11 branch target address from the compiler's own `je <x11_init>` (0f 84 <disp32>) at matchPos + 32
        const x11Disp32 = buf.readInt32LE(matchPos + 34);
        const x11Target = matchPos + 38 + x11Disp32;
        const jmpFromEntryRel32 = x11Target - (entryPos + 5);

        const backupPath = nodePath + ".orig";
        if (!fs.existsSync(backupPath)) {
            fs.copyFileSync(nodePath, backupPath);
        }

        // 1) At entryPos (0x8bd98): jmp <x11Target>; nop
        buf[entryPos] = 0xe9;
        buf.writeInt32LE(jmpFromEntryRel32, entryPos + 1);
        buf[entryPos + 5] = 0x66;
        buf[entryPos + 6] = 0x90;

        // 2) At matchPos + 15: nop; nop (disable je <wayland_init>)
        buf[matchPos + 15] = 0x90;
        buf[matchPos + 16] = 0x90;

        // 3) At matchPos + 32: nop; jmp <x11Target> (turn conditional je into unconditional jmp)
        buf[matchPos + 32] = 0x90;
        buf[matchPos + 33] = 0xe9;

        const tmpPath = nodePath + ".boost_tmp";
        fs.writeFileSync(tmpPath, buf, { mode: 0o755 });
        fs.renameSync(tmpPath, nodePath);
        log("Patched discord_utils.node (relocation-independent): bypassed Wayland GlobalShortcuts -> X11 input in", nodePath);
        return true;
    } catch (e) {
        console.warn("[DiscordBoost] discord_utils patch error:", e.message);
        return false;
    }
}

const INPUT_CAPTURE_MARKER = "/* [DiscordBoost:ForceX11Input] */";
function patchDiscordUtilsInputCaptureJs(jsPath) {
    try {
        if (!fs.existsSync(jsPath)) return false;
        const content = fs.readFileSync(jsPath, "utf8");
        if (content.includes(INPUT_CAPTURE_MARKER)) return false;
        const updated = content.replace(
            /const IS_WAYLAND_SESSION = IS_LINUX[\s\S]*?;\n/,
            `const IS_WAYLAND_SESSION = false; ${INPUT_CAPTURE_MARKER}\n`
        );
        if (updated !== content) {
            fs.writeFileSync(jsPath, updated, "utf8");
            log("Patched input_capture.js: disabled Wayland portal keybind filter in", jsPath);
            return true;
        }
        return false;
    } catch (e) {
        console.warn("[DiscordBoost] input_capture.js patch error:", e.message);
        return false;
    }
}

// 5. Scan all app-* directories in ~/.config/discord and apply patches
function scanAndPatchAllVersions() {
    try {
        if (!fs.existsSync(DISCORD_CONFIG_DIR)) return;
        const entries = fs.readdirSync(DISCORD_CONFIG_DIR);
        for (const entry of entries) {
            if (!entry.startsWith("app-")) continue;
            const modulesDir = path.join(DISCORD_CONFIG_DIR, entry, "modules");
            if (!fs.existsSync(modulesDir)) continue;
            for (const mod of fs.readdirSync(modulesDir)) {
                if (mod.startsWith("discord_voice")) {
                    const voiceDir = path.join(modulesDir, mod, "discord_voice");
                    patchDiscordVoiceBinary(path.join(voiceDir, "discord_voice.node"));
                    patchDiscordVoiceJs(path.join(voiceDir, "index.js"));
                } else if (mod.startsWith("discord_utils")) {
                    const utilsDir = path.join(modulesDir, mod, "discord_utils");
                    patchDiscordUtilsBinary(path.join(utilsDir, "discord_utils.node"));
                    patchDiscordUtilsInputCaptureJs(path.join(utilsDir, "input_capture.js"));
                }
            }
        }
    } catch (e) {
        console.warn("[DiscordBoost] Scan error:", e.message);
    }
}

// 6. Ensure settings.json has hardware acceleration enabled
function ensureSettingsOptimized() {
    try {
        const settingsPath = path.join(DISCORD_CONFIG_DIR, "settings.json");
        if (!fs.existsSync(settingsPath)) return;
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        let changed = false;
        if (settings.enableHardwareAcceleration !== true) {
            settings.enableHardwareAcceleration = true;
            changed = true;
        }
        if (settings.offloadAdmControls !== true) {
            settings.offloadAdmControls = true;
            changed = true;
        }
        if (changed) {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
            log("Updated settings.json with hardware acceleration & offloadAdmControls");
        }
    } catch (e) {}
}

// Run file patches immediately
fixWirePlumberMute();
fixSpeechDispatcherDummy();
cleanKdeDiscordPortalShortcuts();
ensureSettingsOptimized();
scanAndPatchAllVersions();
unmuteLiveDiscordCapture();

// 7. Apply Electron Main-Process GPU/Wayland flags & OpenAsar-style telemetry blocker
try {
    const electron = require("electron");
    if (electron && electron.app) {
        const { app } = electron;
        const IS_NVIDIA_GPU = fs.existsSync("/proc/driver/nvidia");

        // GPU Architecture note for Electron 44+ (app-1.0.167+):
        // - Outgoing streams on NVIDIA use discord_voice.node's built-in native Rust CUDA + NVENC
        //   encoder (CudaVideoEncoder via libcuda.so.1 / libnvidia-encode.so.1), NOT Chromium VA-API.
        // - Incoming streams use ElectronVideoDecoder -> Chromium's VideoDecoder pipeline.
        //   On NVIDIA with libva-nvidia-driver (nvidia-vaapi-driver) installed:
        //   * Forcing VaapiVideoDecodeLinuxGL + VaapiIgnoreDriverChecks WITHOUT ZeroCopy causes an
        //     infinite loading spinner (video-stream-receiver-ready-timeout) because libva-nvidia-driver
        //     only implements DMA-BUF ZeroCopy export and returns VA_STATUS_ERROR_UNIMPLEMENTED for
        //     non-ZeroCopy surfaces without falling back to software decode.
        //   * Enabling ZeroCopy (AcceleratedVideoDecodeLinuxZeroCopyGL) on libva-nvidia-driver causes
        //     +1/-1 out-of-order frame bounce jitter due to missing Wayland explicit sync fences.
        //   Therefore, on NVIDIA we disable Chromium's VA-API video decoder wrapper so ElectronVideoDecoder
        //   uses sequential FFmpeg/dav1d decode + hardware OpenGL GPU compositing (streams open in ~20ms
        //   with zero frame-order bugs), while AMD/Intel Mesa uses native VA-API hardware decode/encode.
        const REQUIRED_ENABLE_FEATURES = IS_NVIDIA_GPU
            ? [
                  "CanvasOopRasterization",
                  "WebRTCPipeWireCapturer"
              ]
            : [
                  "AcceleratedVideoDecodeLinuxGL",
                  "AcceleratedVideoDecoder",
                  "AcceleratedVideoEncoder",
                  "VaapiVideoDecodeLinuxGL",
                  "VaapiVideoEncoder",
                  "VaapiIgnoreDriverChecks",
                  "CanvasOopRasterization",
                  "WebRTCPipeWireCapturer"
              ];

        const REQUIRED_DISABLE_FEATURES = IS_NVIDIA_GPU
            ? [
                  "AcceleratedVideoDecodeLinuxGL",
                  "AcceleratedVideoDecodeLinuxZeroCopyGL",
                  "AcceleratedVideoDecoder",
                  "VaapiVideoDecodeLinuxGL",
                  "VaapiIgnoreDriverChecks"
              ]
            : [
                  "AcceleratedVideoDecodeLinuxZeroCopyGL"
              ];

        const origAppendSwitch = app.commandLine.appendSwitch.bind(app.commandLine);
        app.commandLine.appendSwitch = function (switchName, value) {
            if (switchName === "enable-features") {
                const existing = app.commandLine.getSwitchValue("enable-features");
                const existingList = existing ? String(existing).split(",").filter(Boolean) : [];
                const incoming = value ? String(value).split(",").filter(Boolean) : [];
                const merged = Array.from(new Set([...existingList, ...incoming, ...REQUIRED_ENABLE_FEATURES]))
                    .filter((f) => !REQUIRED_DISABLE_FEATURES.includes(f))
                    .join(",");
                return origAppendSwitch("enable-features", merged);
            }
            if (switchName === "disable-features") {
                const existing = app.commandLine.getSwitchValue("disable-features");
                const existingList = existing ? String(existing).split(",").filter(Boolean) : [];
                const incoming = value ? String(value).split(",").filter(Boolean) : [];
                const merged = Array.from(new Set([...existingList, ...incoming, ...REQUIRED_DISABLE_FEATURES])).join(",");
                return origAppendSwitch("disable-features", merged);
            }
            return origAppendSwitch(switchName, value);
        };

        // Unlock full Linux/Wayland GPU acceleration
        app.commandLine.appendSwitch("ignore-gpu-blocklist");
        app.commandLine.appendSwitch("enable-gpu-rasterization");
        app.commandLine.appendSwitch("disable-renderer-backgrounding");
        app.commandLine.appendSwitch("disable-background-timer-throttling");
        app.commandLine.appendSwitch("webrtc-max-cpu-consumption-percentage", "100");
        app.commandLine.appendSwitch("enable-features", app.commandLine.getSwitchValue("enable-features"));
        app.commandLine.appendSwitch("disable-features", app.commandLine.getSwitchValue("disable-features"));

        log("Applied GPU, Wayland & WebRTC command-line switches (with appendSwitch guard)");

        // Hook browser-window-created so modules unpacked during self-update are patched
        // synchronously BEFORE the main renderer window loads discord_utils.node / discord_voice.node
        app.on("browser-window-created", () => {
            scanAndPatchAllVersions();
        });

        app.whenReady().then(() => {
            scanAndPatchAllVersions();
            fixWirePlumberMute();
            unmuteLiveDiscordCapture();
            cleanKdeDiscordPortalShortcuts();

            // Block Sentry / Science telemetry endpoints at network layer (like OpenAsar)
            try {
                const { session } = electron;
                if (session && session.defaultSession) {
                    session.defaultSession.webRequest.onBeforeRequest(
                        {
                            urls: [
                                "*://*.sentry.io/*",
                                "*://discord.com/api/*/science*",
                                "*://discordapp.com/api/*/science*",
                                "*://discord.com/api/*/metrics*",
                                "*://discordapp.com/api/*/metrics*"
                            ]
                        },
                        (details, callback) => callback({ cancel: true })
                    );
                    log("Installed main-process telemetry & Sentry blocker");
                }
            } catch (e) {}
        });

        // Periodic background check (every 15s) to auto-patch updates and keep discord_capture unmuted
        setInterval(() => {
            scanAndPatchAllVersions();
            fixWirePlumberMute();
            unmuteLiveDiscordCapture();
        }, 15000).unref();
    }
} catch (e) {
    // Not running inside Electron main process (e.g. CLI invocation)
}
