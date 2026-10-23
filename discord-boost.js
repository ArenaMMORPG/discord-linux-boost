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

// 2. Patch PulseAudioController::MonitorSinkInput() in discord_voice.node:
// By default, Discord calls pa_stream_connect_record(stream, NULL, NULL, 0) with attr=NULL and flags=0.
// On PipeWire (pipewire-pulse), attr=NULL sets pulse.attr.fragsize = 384000 bytes (2.0 seconds) and
// node.latency = 96000/48000 (2.0 seconds), causing PipeWire to buffer audio for 2 seconds and deliver
// giant 65536-byte (341.33 ms = 34 frames) bursts every 341ms instead of 10ms frames!
// We patch the pa_stream_connect_record call in MonitorSinkInput (0x470ba9..0x470be5) to pass:
//   pa_buffer_attr { maxlength=-1, tlength=-1, prebuf=-1, minreq=-1, fragsize=1920 (10ms) }
//   flags = PA_STREAM_ADJUST_LATENCY (0x2000)
// so PipeWire sets node.latency = 480/48000 (10ms) and delivers exact 1920-byte (10ms) frames every 10ms.
const VOICE_MONITOR_ORIG = Buffer.from(
    "4c89f731f631d231c9e85905e2ff85c0787de8f053f0ff84c07521488d3d1ad83c01488d355fe33d01488d0daae53d01ba2906000031c0e80b5b2300",
    "hex"
);
const VOICE_MONITOR_PATCH = Buffer.from(
    "4c89f731f6488d151b000000b900200000e85105e2ff85c07875eb209090909090909090909090ffffffffffffffffffffffffffffffff8007000090",
    "hex"
);
const VOICE_READ_AVAIL_ORIG = Buffer.from(
    "498b4424288b4010418b8e08f1020029c84801c089d94839c80f43c389c3ebb3",
    "hex"
);

function patchDiscordVoiceBinary(nodePath) {
    try {
        if (!fs.existsSync(nodePath)) return false;
        const backupPath = nodePath + ".orig";
        let buf = fs.readFileSync(nodePath);

        // If ReadAvailable() was modified by an older experimental patch, restore from .orig first
        if (buf.indexOf(VOICE_READ_AVAIL_ORIG) === -1 && fs.existsSync(backupPath)) {
            buf = fs.readFileSync(backupPath);
        }

        if (buf.indexOf(VOICE_MONITOR_PATCH) !== -1 && buf.indexOf(VOICE_READ_AVAIL_ORIG) !== -1) {
            const diskBuf = fs.readFileSync(nodePath);
            if (diskBuf.equals(buf)) return false;
        }

        const idx = buf.indexOf(VOICE_MONITOR_ORIG);
        if (idx !== -1) {
            if (!fs.existsSync(backupPath)) {
                fs.copyFileSync(nodePath, backupPath);
            }
            VOICE_MONITOR_PATCH.copy(buf, idx);
        } else if (buf.indexOf(VOICE_MONITOR_PATCH) === -1) {
            return false;
        }

        const tmpPath = nodePath + ".boost_tmp";
        fs.writeFileSync(tmpPath, buf, { mode: 0o755 });
        fs.renameSync(tmpPath, nodePath);
        log("Patched PulseAudioController::MonitorSinkInput (fragsize=1920, PA_STREAM_ADJUST_LATENCY) in", nodePath);
        return true;
    } catch (e) {
        console.warn("[DiscordBoost] Binary patch error:", e.message);
        return false;
    }
}

// 3. Patch discord_voice/index.js for Stereo 160kbps Opus & 12Mbps NVENC Stream Bitrate
const VOICE_JS_MARKER = "/* [DiscordBoost:TransportOptions:v3] */";
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
                    // Boost video bitrate ONLY when WE are encoding an outgoing stream!
                    // Do NOT force callBitRate / callMaxBitRate on incoming connections,
                    // otherwise receiving streams from friends causes jitter buffer oscillation
                    // and out-of-order frame bouncing (+1/-1 frame).
                    if (options.encodingVideoBitRate || options.encodingVideoMaxBitRate) {
                        if (options.encodingVideoMinBitRate && options.encodingVideoMinBitRate < 4000000) {
                            options.encodingVideoMinBitRate = 4000000;
                        }
                        if (options.encodingVideoBitRate && options.encodingVideoBitRate < 10000000) {
                            options.encodingVideoBitRate = 10000000;
                        }
                        if (options.encodingVideoMaxBitRate && options.encodingVideoMaxBitRate < 12000000) {
                            options.encodingVideoMaxBitRate = 12000000;
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
            return false; // Already patched with v3
        }
        let updated = content;
        if (content.includes("/* [DiscordBoost:TransportOptions")) {
            // Replace previous v1/v2 patch
            updated = content.replace(
                /setTransportOptions:\s*\(options\)\s*=>\s*\{\s*\/\*\s*\[DiscordBoost:TransportOptions[^\]]*\][\s\S]*?return instance\.setTransportOptions\(options\);\s*\},/,
                VOICE_JS_REPLACEMENT
            );
        } else if (content.includes(VOICE_JS_TARGET)) {
            // Fresh target
            updated = content.replace(VOICE_JS_TARGET, VOICE_JS_REPLACEMENT);
        } else {
            return false;
        }

        if (updated !== content) {
            fs.writeFileSync(jsPath, updated, "utf8");
            log("Patched Stereo 160kbps Opus & 12Mbps video transport options (v3) in", jsPath);
            return true;
        }
        return false;
    } catch (e) {
        console.warn("[DiscordBoost] JS patch error:", e.message);
        return false;
    }
}

// 4. Binary patch discord_utils.node to bypass Wayland GlobalShortcuts portal
// and force native XWayland/X11 input monitoring so "Global Shortcuts Requested"
// NEVER pops up and UNK197 / F19 / Numpad* work directly.
const UTILS_ORIG_SIG = Buffer.from("488d3d48f40800", "hex");
const UTILS_PATCH_SIG = Buffer.from("e9190400006690", "hex");

function patchDiscordUtilsBinary(nodePath) {
    try {
        if (!fs.existsSync(nodePath)) return false;
        const buf = fs.readFileSync(nodePath);
        if (buf.includes(UTILS_PATCH_SIG)) {
            return false; // Already patched
        }
        const idx = buf.indexOf(UTILS_ORIG_SIG);
        if (idx === -1) {
            return false;
        }
        const backupPath = nodePath + ".orig";
        if (!fs.existsSync(backupPath)) {
            fs.copyFileSync(nodePath, backupPath);
        }
        UTILS_PATCH_SIG.copy(buf, idx);
        const tmpPath = nodePath + ".boost_tmp";
        fs.writeFileSync(tmpPath, buf, { mode: 0o755 });
        fs.renameSync(tmpPath, nodePath);
        log("Patched discord_utils.node: bypassed Wayland GlobalShortcuts portal -> X11 input");
        return true;
    } catch (e) {
        console.warn("[DiscordBoost] discord_utils patch error:", e.message);
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
ensureSettingsOptimized();
scanAndPatchAllVersions();
unmuteLiveDiscordCapture();

// 7. Apply Electron Main-Process GPU/Wayland flags & OpenAsar-style telemetry blocker
try {
    const electron = require("electron");
    if (electron && electron.app) {
        const { app } = electron;

        // Unlock full Linux/Wayland GPU acceleration
        app.commandLine.appendSwitch("ignore-gpu-blocklist");
        app.commandLine.appendSwitch("enable-gpu-rasterization");
        app.commandLine.appendSwitch("disable-renderer-backgrounding");
        app.commandLine.appendSwitch("disable-background-timer-throttling");
        app.commandLine.appendSwitch("webrtc-max-cpu-consumption-percentage", "100");

        const gpuFeatures = [
            "AcceleratedVideoDecodeLinuxGL",
            "AcceleratedVideoDecoder",
            "AcceleratedVideoEncoder",
            "VaapiVideoDecodeLinuxGL",
            "VaapiVideoEncoder",
            "VaapiIgnoreDriverChecks",
            "CanvasOopRasterization",
            "WebRTCPipeWireCapturer"
        ];
        const existingFeatures = app.commandLine.getSwitchValue("enable-features");
        const combinedFeatures = existingFeatures
            ? Array.from(new Set([...existingFeatures.split(","), ...gpuFeatures])).join(",")
            : gpuFeatures.join(",");
        app.commandLine.appendSwitch("enable-features", combinedFeatures);

        // Explicitly disable ZeroCopy video decoding: on NVIDIA Wayland (nvidia-vaapi-driver/NVDEC),
        // AcceleratedVideoDecodeLinuxZeroCopyGL causes EGL buffer presentation sync race conditions,
        // resulting in frames jumping forward and backward (+1/-1 frame bounce jitter).
        // Disabling zero-copy ensures frames are rendered smoothly in strict sequential order.
        const disabledFeatures = [
            "AcceleratedVideoDecodeLinuxZeroCopyGL"
        ];
        const existingDisabled = app.commandLine.getSwitchValue("disable-features");
        const combinedDisabled = existingDisabled
            ? Array.from(new Set([...existingDisabled.split(","), ...disabledFeatures])).join(",")
            : disabledFeatures.join(",");
        app.commandLine.appendSwitch("disable-features", combinedDisabled);

        log("Applied GPU, Wayland & WebRTC command-line switches");

        app.whenReady().then(() => {
            // Re-scan in case updater unpacked modules during startup
            scanAndPatchAllVersions();
            fixWirePlumberMute();
            unmuteLiveDiscordCapture();

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
