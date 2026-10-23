#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "  Discord Linux Boost & Audio/Wayland Fix Installer"
echo "============================================================"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
TARGET_DIR="$HOME/.config/Vencord"
BOOST_PATH="$TARGET_DIR/discord-boost.js"

mkdir -p "$TARGET_DIR"
if [ -f "$SCRIPT_DIR/discord-boost.js" ]; then
    cp -f "$SCRIPT_DIR/discord-boost.js" "$BOOST_PATH"
else
    echo "[*] Downloading discord-boost.js from GitHub..."
    curl -fsSL "https://raw.githubusercontent.com/ArenaMMORPG/discord-linux-boost/main/discord-boost.js" -o "$BOOST_PATH"
fi
echo "[+] Installed preloader to: $BOOST_PATH"

# 1. Fix WirePlumber persistent mute on discord_capture
WP_PROPS="$HOME/.local/state/wireplumber/stream-properties"
if [ -f "$WP_PROPS" ]; then
    sed -i 's/\(Input\/Audio:application\.name:discord_capture={.*\)"mute":true/\1"mute":false/g' "$WP_PROPS" || true
    echo "[+] Checked WirePlumber stream-properties (discord_capture unmuted)"
fi

if command -v pactl >/dev/null 2>&1; then
    for idx in $(pactl list source-outputs 2>/dev/null | awk '/Source Output #/{gsub("#","",$3); id=$3} /application.name = "discord_capture"/{print id}'); do
        pactl set-source-output-mute "$idx" 0 2>/dev/null || true
        pactl set-source-output-volume "$idx" 100% 2>/dev/null || true
    done
fi

# 2. Disable speech-dispatcher dummy stream (sd_dummy)
mkdir -p "$HOME/.config/speech-dispatcher"
if ! grep -q "DisableAutoSpawn" "$HOME/.config/speech-dispatcher/speechd.conf" 2>/dev/null; then
    echo "DisableAutoSpawn" >> "$HOME/.config/speech-dispatcher/speechd.conf"
fi
killall speech-dispatcher sd_dummy sd_espeak-ng 2>/dev/null || true
echo "[+] Disabled speech-dispatcher (sd_dummy) auto-spawn"

# 3. Inject discord-boost.js into Discord's app.asar (preserving Vencord if installed)
python3 - "$BOOST_PATH" << 'EOF'
import struct, glob, os, shutil, sys, re

boost_path = sys.argv[1]
home = os.path.expanduser("~")

# Detect Vencord patcher.js if present
vencord_candidates = [
    os.path.join(home, ".config", "Vencord", "dist", "patcher.js"),
    os.path.join(home, ".config", "equicord", "dist", "patcher.js"),
    os.path.join(home, ".local", "share", "Vencord", "dist", "patcher.js"),
    "/usr/share/vencord/patcher.js",
    "/usr/lib/vencord/patcher.js",
]
vencord_patcher = next((p for p in vencord_candidates if os.path.exists(p)), None)

res_dirs = glob.glob(os.path.expanduser("~/.config/discord/app-*/resources"))
for sys_dir in ["/opt/discord/resources", "/usr/lib/discord/resources", "/usr/share/discord/resources"]:
    if os.path.exists(sys_dir) and os.access(sys_dir, os.W_OK):
        res_dirs.append(sys_dir)

for res_dir in res_dirs:
    app_asar = os.path.join(res_dir, "app.asar")
    orig_asar = os.path.join(res_dir, "_app.asar")

    # If small app.asar already exists (e.g. from Vencord), inspect it for custom patcher path
    detected_patcher = vencord_patcher
    if os.path.exists(app_asar) and os.path.getsize(app_asar) < 10000:
        try:
            raw = open(app_asar, "rb").read().decode("utf-8", errors="ignore")
            m = re.search(r'require\(["\']([^"\']*patcher\.js)["\']\)', raw)
            if m and os.path.exists(m.group(1)):
                detected_patcher = m.group(1)
        except Exception:
            pass

    if os.path.exists(app_asar) and not os.path.exists(orig_asar) and os.path.getsize(app_asar) > 10000:
        shutil.move(app_asar, orig_asar)

    if detected_patcher:
        chain_target = detected_patcher
        print(f"[+] Chaining DiscordBoost + Vencord ({chain_target}) in {res_dir}")
    else:
        chain_target = os.path.join(res_dir, "_app.asar")
        print(f"[+] Chaining DiscordBoost + native _app.asar in {res_dir}")

    index_js = f'require({boost_path!r});require({chain_target!r});\n'.encode("utf-8")
    pkg_json = b'{\n\t"name": "discord",\n\t"main": "index.js"\n}'

    header_json = (
        '{"files":{"index.js":{"size":'
        + str(len(index_js))
        + ',"offset":"0"},"package.json":{"size":'
        + str(len(pkg_json))
        + ',"offset":"'
        + str(len(index_js))
        + '"}}}'
    ).encode("utf-8")

    pad_len = (4 - (len(header_json) % 4)) % 4
    padded_header = header_json + (b"\x00" * pad_len)
    pickle_payload_size = 4 + len(padded_header)
    asar_bytes = (
        struct.pack("<IIII", 4, pickle_payload_size + 4, pickle_payload_size, len(header_json))
        + padded_header
        + index_js
        + pkg_json
    )

    with open(app_asar, "wb") as f:
        f.write(asar_bytes)
EOF

# 4. Run binary & JS patches immediately
if command -v node >/dev/null 2>&1; then
    node "$BOOST_PATH"
else
    echo "[!] 'node' CLI not found; patches will be applied automatically by Electron when Discord starts."
fi

echo "============================================================"
echo "  Done! Restart Discord completely (Quit from tray & open)."
echo "============================================================"
