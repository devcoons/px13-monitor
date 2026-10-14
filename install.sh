#!/usr/bin/env bash
# Install PX13 Monitor into the per-user GNOME Shell extensions directory.
set -euo pipefail

UUID="px13-monitor@devcoons"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/${UUID}"

rm -rf "${DEST}"
mkdir -p "${DEST}/schemas"

cp "${ROOT}/metadata.json" \
   "${ROOT}/extension.js" \
   "${ROOT}/sensors.js" \
   "${ROOT}/digits.js" \
   "${ROOT}/history.js" \
   "${ROOT}/prefs.js" \
   "${ROOT}/stylesheet.css" \
   "${DEST}/"
cp "${ROOT}/schemas/"*.xml "${DEST}/schemas/"
glib-compile-schemas "${DEST}/schemas"

# GNOME Shell only scans extension directories at login. Putting the UUID in
# enabled-extensions makes it start on the next session. If this shell already
# knows the extension, enable it immediately too.
if command -v gsettings >/dev/null; then
    python3 - "${UUID}" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
    text=True,
).strip()
enabled = ast.literal_eval(raw)
if uuid not in enabled:
    enabled.append(uuid)
    subprocess.check_call([
        "gsettings", "set", "org.gnome.shell", "enabled-extensions",
        "[" + ", ".join(f"'{item}'" for item in enabled) + "]",
    ])
PY
fi

if command -v gnome-extensions >/dev/null; then
    gnome-extensions enable "${UUID}" || true
fi

echo "Installed ${UUID}"
echo "Destination: ${DEST}"
echo "Log out and back in if the indicator is not in the top bar yet."
