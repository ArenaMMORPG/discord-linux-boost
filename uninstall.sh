#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "  Uninstalling Discord Linux Boost & Restoring Backups"
echo "============================================================"

# Restore .orig binaries
for orig in "$HOME"/.config/discord/app-*/modules/*/discord_*/*.node.orig; do
    [ -e "$orig" ] || continue
    target="${orig%.orig}"
    cp -f "$orig" "$target"
    echo "[+] Restored original binary: $target"
done

# Restore index.js transport options
for js in "$HOME"/.config/discord/app-*/modules/discord_voice-*/discord_voice/index.js; do
    [ -e "$js" ] || continue
    node -e '
        const fs = require("fs");
        const p = process.argv[1];
        const c = fs.readFileSync(p, "utf8");
        const u = c.replace(
            /setTransportOptions:\s*\(options\)\s*=>\s*\{\s*\/\*\s*\[DiscordBoost:TransportOptions[^\]]*\][\s\S]*?return instance\.setTransportOptions\(options\);\s*\},/,
            "setTransportOptions: (options) => instance.setTransportOptions(options),"
        );
        if (u !== c) {
            fs.writeFileSync(p, u, "utf8");
            console.log("[+] Restored clean index.js:", p);
        }
    ' "$js"
done

# Restore app.asar (keep Vencord if installed, otherwise restore _app.asar)
python3 - << 'EOF'
import struct, glob, os, shutil

home = os.path.expanduser("~")
vencord_patcher = os.path.join(home, ".config", "Vencord", "dist", "patcher.js")

for res_dir in glob.glob(os.path.expanduser("~/.config/discord/app-*/resources")):
    app_asar = os.path.join(res_dir, "app.asar")
    orig_asar = os.path.join(res_dir, "_app.asar")
    if os.path.exists(vencord_patcher) and os.path.exists(orig_asar):
        index_js = f'require({vencord_patcher!r});\n'.encode("utf-8")
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
        print("[+] Restored Vencord-only app.asar in:", res_dir)
    elif os.path.exists(orig_asar):
        shutil.move(orig_asar, app_asar)
        print("[+] Restored original app.asar in:", res_dir)
EOF

rm -f "$HOME/.config/Vencord/discord-boost.js"
echo "============================================================"
echo "  Uninstall complete. Restart Discord to apply."
echo "============================================================"
