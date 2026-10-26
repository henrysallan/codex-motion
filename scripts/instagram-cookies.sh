#!/usr/bin/env bash
# Saves your Instagram session from Chrome for the Instagram importer
# (scripts/instagram.ts), which loads it into its headless browser when a
# logged-out page view hits Instagram's login wall.
#
#   scripts/instagram-cookies.sh                 # Chrome's Default profile
#   scripts/instagram-cookies.sh "Profile 1"     # another Chrome profile
#
# Run it from your own terminal: macOS doesn't let the Claude app read
# Chrome's data. It reads Chrome's cookie store through yt-dlp's Python
# module (macOS asks once for the "Chrome Safe Storage" keychain item),
# keeps only instagram.com's cookies, and writes them to
# ~/.config/codex-motion/instagram-cookies.txt (mode 600, Netscape format).
# Nothing else from the cookie store is written anywhere. Re-run when the
# session expires (the importer says so).
#
# Env: INSTAGRAM_COOKIES (output path), PYTHON (default python3, the one
# yt-dlp is installed for).
set -euo pipefail

PROFILE=${1:-}
OUT=${INSTAGRAM_COOKIES:-$HOME/.config/codex-motion/instagram-cookies.txt}
mkdir -p "$(dirname "$OUT")"
chmod 700 "$(dirname "$OUT")"

"${PYTHON:-python3}" - "$OUT" "$PROFILE" <<'PY'
import os, sys
from yt_dlp.cookies import YoutubeDLCookieJar, extract_cookies_from_browser

out, profile = sys.argv[1], sys.argv[2] or None
jar = extract_cookies_from_browser('chrome', profile)
keep = YoutubeDLCookieJar()
for c in jar:
    if c.domain.lstrip('.') == 'instagram.com' or c.domain.endswith('.instagram.com'):
        # Some yt-dlp versions pass Chrome's own timestamps through
        # (microseconds since 1601); cookies.txt wants Unix seconds.
        if c.expires and c.expires > 1e12:
            c.expires = int(c.expires / 1e6 - 11644473600)
        keep.set_cookie(c)
tmp = out + '.part'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.close(fd)
keep.save(tmp)
os.chmod(tmp, 0o600)
os.replace(tmp, out)
names = {c.name for c in keep}
print(f'{len(names)} instagram.com cookies -> {out}')
if 'sessionid' not in names:
    print('No sessionid cookie: this Chrome profile is not logged in to Instagram. Log in at instagram.com in Chrome, then re-run.')
    sys.exit(1)
PY
