#!/usr/bin/env bash
# Installs the motion.isthishenry native messaging host and registers it with Chrome
# (and any Chrome-based browsers present).
#
# The helper is COPIED to ~/Library/Application Support/motion.isthishenry rather than run
# from this folder: macOS blocks Chrome's child processes from reading files in
# privacy-protected folders such as ~/Documents and ~/Desktop, which shows up in
# the extension as "Helper disconnected: native host has exited".
#
#   ./host/install.sh              install / update (re-run after editing motion_host.py)
#   ./host/install.sh --uninstall

set -euo pipefail

HOST_NAME="com.isthishenry.motion.host"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC_SCRIPT="$HERE/motion_host.py"
MANIFEST="$ROOT/manifest.json"

INSTALL_DIR="$HOME/Library/Application Support/motion.isthishenry"
HOST_SCRIPT="$INSTALL_DIR/motion_host.py"
LOG_FILE="$HOME/Library/Logs/motion.isthishenry/host.log"

# What this helper was called before the extension moved into codex-motion.
# Installing removes it, so Chrome doesn't keep a second registration around.
OLD_HOST_NAME="com.videopull.host"
OLD_INSTALL_DIR="$HOME/Library/Application Support/VideoPull"

BROWSER_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome"
  "$HOME/Library/Application Support/Google/Chrome Beta"
  "$HOME/Library/Application Support/Google/Chrome Canary"
  "$HOME/Library/Application Support/Chromium"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
  "$HOME/Library/Application Support/Arc/User Data"
  "$HOME/Library/Application Support/Microsoft Edge"
  "$HOME/Library/Application Support/Vivaldi"
)

remove_host() {
  local name="$1" install_dir="$2"
  for dir in "${BROWSER_DIRS[@]}"; do
    f="$dir/NativeMessagingHosts/$name.json"
    if [[ -f "$f" ]]; then rm -f "$f"; echo "removed $f"; fi
  done
  if [[ -d "$install_dir" ]]; then rm -rf "$install_dir"; echo "removed $install_dir"; fi
}

remove_host "$OLD_HOST_NAME" "$OLD_INSTALL_DIR"

if [[ "${1:-}" == "--uninstall" ]]; then
  remove_host "$HOST_NAME" "$INSTALL_DIR"
  exit 0
fi

[[ -f "$MANIFEST" ]] || { echo "manifest.json not found at $MANIFEST" >&2; exit 1; }
[[ -f "$SRC_SCRIPT" ]] || { echo "host script not found at $SRC_SCRIPT" >&2; exit 1; }

# Pick the interpreter Chrome will be able to run. /usr/bin/python3 ships with
# macOS (via the Command Line Tools) and is always on Chrome's minimal PATH.
PYTHON="/usr/bin/python3"
if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
  PYTHON="$(command -v python3 || true)"
  [[ -n "$PYTHON" ]] || { echo "python3 not found. Install the Xcode Command Line Tools: xcode-select --install" >&2; exit 1; }
fi

# Extension ID = first 128 bits of SHA-256(public key DER), hex mapped to a–p.
EXT_ID="$("$PYTHON" - "$MANIFEST" <<'PY'
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1]))["key"]
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in digest))
PY
)"

# Install the helper with an absolute-interpreter shebang so nothing depends on PATH.
mkdir -p "$INSTALL_DIR"
{
  echo "#!$PYTHON"
  tail -n +2 "$SRC_SCRIPT"
} > "$HOST_SCRIPT"
chmod 755 "$HOST_SCRIPT"

HOST_JSON="$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "motion.isthishenry helper: runs yt-dlp for the motion.isthishenry Chrome extension",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)"

installed=0
for dir in "${BROWSER_DIRS[@]}"; do
  [[ -d "$dir" ]] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  printf '%s\n' "$HOST_JSON" > "$dir/NativeMessagingHosts/$HOST_NAME.json"
  echo "registered → $dir/NativeMessagingHosts/$HOST_NAME.json"
  installed=1
done

if [[ $installed -eq 0 ]]; then
  echo "No Chrome-based browser profile directory found. Launch Chrome once, then re-run." >&2
  exit 1
fi

# Self-test the installed copy the way Chrome runs it: minimal environment, framed ping.
echo
echo -n "self-test    : "
if env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" "$PYTHON" - "$HOST_SCRIPT" <<'PY'
import json, struct, subprocess, sys
p = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
msg = json.dumps({"cmd": "ping"}).encode()
p.stdin.write(struct.pack("@I", len(msg)) + msg); p.stdin.flush(); p.stdin.close()
hdr = p.stdout.read(4)
if len(hdr) < 4:
    print("FAILED (no reply)"); sys.exit(1)
(n,) = struct.unpack("@I", hdr)
reply = json.loads(p.stdout.read(n))
ok = reply.get("type") == "pong" and reply.get("ytdlp")
print(("ok" if ok else "FAILED") + f" — yt-dlp={reply.get('ytdlp')} ({reply.get('version')}) ffmpeg={reply.get('ffmpeg')}")
sys.exit(0 if ok else 1)
PY
then :; else
  echo "The helper did not answer a ping. See $LOG_FILE" >&2
  exit 1
fi

echo
echo "Extension ID : $EXT_ID"
echo "Helper       : $HOST_SCRIPT"
echo "Interpreter  : $PYTHON"
echo "Log          : $LOG_FILE"
echo
echo "Next: in chrome://extensions, Load unpacked → $ROOT (or reload it if it's already loaded from there)."
echo "      Its ID must read $EXT_ID. A VideoPull card loaded from another folder has the same ID: remove it first."
echo "First Vimeo/Instagram download shows a macOS Keychain prompt so yt-dlp can read Chrome's cookies — click Always Allow."
