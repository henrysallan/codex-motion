#!/usr/bin/env bash
# Retries a site's failed Vimeo downloads from a scraper run, one at a time.
#
#   scripts/vimeo-retry.sh media/scraped/futuredeluxe.com [out-dir]
#   DRY_RUN=1 scripts/vimeo-retry.sh media/scraped/futuredeluxe.com   # list only
#
# Reads <site>/scrape.json and takes every failed item with a Vimeo URL. Each
# one goes to yt-dlp with the scraper's settings: the player URL (with its
# unlisted hash), the project page as referer, up to 1080p, merged to mp4,
# 5–8 s apart. After 3 refusals in a row (HTTP 429 or Vimeo's fingerprint
# block) the script stops. Files land in out-dir (default
# media/vimeo-retry/<site>) as <vimeo id>.<ext> with yt-dlp's .info.json
# beside them, and results.tsv records every attempt. Re-running skips what's
# already downloaded.
#
# Videos behind Vimeo's "verify you're human" check fail with HTTP 401 until
# Vimeo lifts it for this machine; this script doesn't try to get past it.
#
# Env: YTDLP (default yt-dlp), FFMPEG (an arm64 ffmpeg for merging).
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: scripts/vimeo-retry.sh media/scraped/<site> [out-dir]" >&2; exit 2; }
SITE_DIR=$(cd "$1" && pwd)
MANIFEST="$SITE_DIR/scrape.json"
[ -f "$MANIFEST" ] || { echo "no scrape.json in $SITE_DIR" >&2; exit 1; }
cd "$(dirname "$0")/.."
OUT=${2:-media/vimeo-retry/$(basename "$SITE_DIR")}
YTDLP=${YTDLP:-yt-dlp}
# The scraper's own user agent (scripts/scrape/site.ts), so requests look the same.
UA=$(node -e "import('./scripts/scrape/site.ts').then((m) => console.log(m.USER_AGENT))")
mkdir -p "$OUT"
LOG="$OUT/results.tsv"
[ -f "$LOG" ] || printf 'time\tvimeo_id\tresult\ttitle\tpage\tdetail\n' > "$LOG"

# One line per failed Vimeo item: id, player URL, referer, title.
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ").trim();
for (const i of j.items ?? []) {
  if (i.status !== "failed") continue;
  const urls = (i.media?.urls ?? []).filter((u) => /vimeo\.com\//.test(u));
  const id = /^vimeo:(\d+)$/.exec(i.key ?? "")?.[1] ?? urls.map((u) => /\/(\d{6,})(?:[/?#]|$)/.exec(u)?.[1]).find(Boolean);
  if (!id || !urls.length) continue;
  const h = urls.map((u) => new URL(u).searchParams.get("h")).find(Boolean);
  console.log([id, `https://player.vimeo.com/video/${id}${h ? `?h=${h}` : ""}`, i.page?.url ?? "", clean(i.title)].join("\t"));
}' "$MANIFEST" > "$OUT/todo.tsv"

total=$(wc -l < "$OUT/todo.tsv" | tr -d ' ')
echo "$total failed Vimeo videos in $MANIFEST → $OUT"
if [ "${DRY_RUN:-}" = 1 ]; then
  cut -f1,2,4 "$OUT/todo.tsv"
  exit 0
fi

ok=0 failed=0 skipped=0 strikes=0 n=0
while IFS=$'\t' read -r id url referer title <&3; do
  n=$((n + 1))
  if [ -e "$OUT/$id.mp4" ] || [ -e "$OUT/$id.mkv" ] || [ -e "$OUT/$id.webm" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  [ "$n" -gt 1 ] && sleep $((5 + RANDOM % 4))
  args=(--no-playlist --no-colors --referer "$referer" --add-headers "User-Agent:$UA" --no-progress
    --retries 5 --fragment-retries 10 --extractor-retries 3 --retry-sleep exp=1:20
    -f 'bv*+ba/b' -S res:1080 --merge-output-format mp4/mkv --write-info-json --no-write-playlist-metafiles --no-mtime
    --match-filter 'duration <=? 900' --max-filesize 500M -o "$OUT/$id.%(ext)s")
  [ -n "${FFMPEG:-}" ] && args+=(--ffmpeg-location "$FFMPEG")
  stamp=$(date '+%H:%M:%S')
  if err=$("$YTDLP" "${args[@]}" "$url" 2>&1 >/dev/null </dev/null); then
    ok=$((ok + 1)) strikes=0
    printf '%s\t%s\tdownloaded\t%s\t%s\t\n' "$stamp" "$id" "$title" "$referer" >> "$LOG"
    echo "[$n/$total] ok      $id  $title"
    continue
  fi
  failed=$((failed + 1))
  detail=$(printf '%s\n' "$err" | grep 'ERROR' | tail -1 | sed 's/^.*ERROR: *//' | cut -c1-200 || true)
  [ -n "$detail" ] || detail=$(printf '%s\n' "$err" | tail -1 | cut -c1-200)
  if printf '%s' "$err" | grep -qE 'TLS fingerprint|HTTP Error 429'; then
    strikes=$((strikes + 1)) result=refused
  else
    strikes=0
    case "$detail" in
      *"HTTP Error 401"*) result=blocked-or-private ;;
      *"HTTP Error 404"*) result=gone ;;
      *) result=failed ;;
    esac
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$stamp" "$id" "$result" "$title" "$referer" "$detail" >> "$LOG"
  echo "[$n/$total] $result  $id  $title"
  if [ "$strikes" -ge 3 ]; then
    echo "Vimeo refused 3 requests in a row; stopping. Re-run later to continue."
    break
  fi
done 3< "$OUT/todo.tsv"

echo "done: $ok downloaded, $failed failed, $skipped already here. Log: $LOG"
