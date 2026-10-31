#!/usr/bin/env python3
"""motion.isthishenry native messaging host.

Chrome launches this process when the extension calls
chrome.runtime.connectNative('com.isthishenry.motion.host'). Messages are JSON, framed
with a 4-byte native-endian length prefix on stdin/stdout.

Requests
  {"cmd": "ping"}
  {"cmd": "download", "url": "...", "referer": "...", "outDir": "~/Downloads/motion.isthishenry",
   "browser": "chrome" | "none", "capture": {...},
   # posts/carousels only:
   "probe": true, "whole": false, "slide": {"index": 3, "count": 7}, "urlIndex": 3, "poster": "..."}
  {"cmd": "tag", "file": "/abs/path.mp4", "capture": {...}}   # a file Chrome downloaded
  {"cmd": "commit" | "abort", "file": "/abs/path.mp4", "tmp": "/abs/path.tag-tmp.mp4"}

The capture is the page context the extension read (background.js
buildCapture). It's written into each saved video's comment tag as JSON,
with yt-dlp's metadata for that file added as "embed", so codex-motion can
read it when the file is dropped in (src/app/capture.ts).

Responses
  {"type": "pong", "ytdlp": "/path/or/null", "ffmpeg": "/path/or/null", "version": "..."}
  {"type": "started", "argv": [...]}
  {"type": "stage", "text": "reading post…"}
  {"type": "progress", "percent": 42.1, "item": "slide 3/7", "line": "[download]  42.1% of ..."}
  {"type": "log", "line": "..."}
  {"type": "done", "ok": true, "file": "/abs/path.mp4", "files": [...], "note": "...", "code": 0}
  {"type": "done", "ok": true, "file": "...", "pending": "/abs/path.tag-tmp.mp4"}   # tag: see "the capture, in the file"
  {"type": "done", "ok": false, "error": "...", "code": 1}
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request

# Chrome starts native hosts with a minimal PATH, so Homebrew etc. must be added.
EXTRA_PATHS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    os.path.expanduser("~/.local/bin"),
    os.path.expanduser("~/Library/Python/3.9/bin"),
    "/usr/bin",
    "/bin",
]

DEFAULT_OUT_DIR = os.path.expanduser("~/Downloads/motion.isthishenry")
FILE_MARKER = "MOTION_FILE="
INFO_MARKER = "MOTION_INFO="

# What the capture keeps of yt-dlp's metadata: who posted it, when, and what
# they said. Counts (views, likes) are left out: they change between saves,
# and the library keys clips by the file's hash.
EMBED_FIELDS = [
    "id", "title", "description", "uploader", "uploader_id", "uploader_url",
    "channel", "channel_id", "channel_url", "creators", "upload_date", "release_date",
    "timestamp", "webpage_url", "extractor_key", "tags", "categories", "duration", "location",
]
# The comment tag is read whole on every drop; past this, page text and
# JSON-LD are dropped first.
CAPTURE_MAX = 48_000

PROGRESS_RE = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")

# Chrome swallows the host's stderr, so anything that goes wrong is written here.
LOG_DIR = os.path.expanduser("~/Library/Logs/motion.isthishenry")
LOG_FILE = os.path.join(LOG_DIR, "host.log")


def log(message):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{os.getpid()}] {message}\n")
    except OSError:
        pass


def build_env():
    env = dict(os.environ)
    parts = [p for p in EXTRA_PATHS if os.path.isdir(p)]
    parts += [p for p in env.get("PATH", "").split(os.pathsep) if p and p not in parts]
    env["PATH"] = os.pathsep.join(parts)
    return env


ENV = build_env()


def which(name):
    return shutil.which(name, path=ENV["PATH"])


# --- framing -----------------------------------------------------------------

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("@I", raw_len)
    data = sys.stdin.buffer.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode("utf-8"))


def send(obj):
    if obj.get("type") != "progress":
        log(f"→ {json.dumps(obj)[:400]}")
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# --- commands ----------------------------------------------------------------

def cmd_ping():
    ytdlp = which("yt-dlp")
    version = None
    if ytdlp:
        try:
            version = subprocess.run(
                [ytdlp, "--version"], capture_output=True, text=True, env=ENV, timeout=15
            ).stdout.strip()
        except Exception as exc:  # noqa: BLE001
            version = f"error: {exc}"
    send({"type": "pong", "ytdlp": ytdlp, "ffmpeg": which("ffmpeg"), "version": version})


def format_args(ytdlp, out_dir):
    """yt-dlp arguments shared by every download."""
    argv = [
        ytdlp,
        "-f", "bv*+ba/b",
        # Prefer codecs QuickTime/Finder can play (H.264 + AAC) over VP9/AV1/Opus
        # at the same quality tier; ensure_quicktime() below transcodes anything
        # that still slips through.
        "-S", "vcodec:h264,acodec:aac",
        "--merge-output-format", "mp4",
        "--newline",
        "--progress",
        "--no-quiet",
        "--print", "after_move:" + FILE_MARKER + "%(filepath)s",
        # The fields the capture keeps, as JSON (missing ones are left out).
        "--print", "after_move:" + INFO_MARKER + "%(.{" + ",".join(EMBED_FIELDS) + "})j",
        "-P", out_dir,
    ]
    ffmpeg = which("ffmpeg")
    if ffmpeg:
        argv += ["--ffmpeg-location", ffmpeg]
    return argv


def cookie_args(msg):
    # browser: "chrome" (default) reads Chrome's cookies for private/unlisted videos;
    # "none" skips cookies entirely (also avoids the macOS Keychain prompt).
    browser = msg.get("browser") or "chrome"
    return [] if browser == "none" else ["--cookies-from-browser", browser]


def run_ytdlp(argv, item=None):
    """Run yt-dlp, streaming progress. Returns (exit_code, final_file, tail_lines, info)."""
    log(f"run: {' '.join(argv)}")
    try:
        proc = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=ENV,
        )
    except Exception as exc:  # noqa: BLE001
        return -1, None, [f"ERROR: Could not start yt-dlp: {exc}"], None

    final_file = None
    info = None
    tail = []
    last_percent_sent = -1.0
    for line in proc.stdout:
        line = line.rstrip("\n")
        if not line:
            continue
        if line.startswith(FILE_MARKER):
            final_file = line[len(FILE_MARKER):]
            continue
        if line.startswith(INFO_MARKER):
            try:
                info = json.loads(line[len(INFO_MARKER):])
            except ValueError as exc:
                log(f"unreadable yt-dlp metadata: {exc}")
            continue
        tail.append(line)
        if len(tail) > 30:
            tail.pop(0)
        m = PROGRESS_RE.search(line)
        if m:
            pct = float(m.group(1))
            # Throttle: only forward meaningful changes.
            if pct >= 100 or pct - last_percent_sent >= 0.5:
                last_percent_sent = pct
                safe_send({"type": "progress", "percent": pct, "item": item, "line": line})
        else:
            safe_send({"type": "log", "line": line})
    return proc.wait(), final_file, tail, info


def first_error(tail, code):
    return next((l for l in reversed(tail) if "ERROR" in l), tail[-1] if tail else f"yt-dlp exited {code}")


def finish(msg, files, note=None, extras=None):
    """Make every file QuickTime-compatible, write the capture into it, then
    report success. `extras` holds, per file, what the capture gains for it:
    yt-dlp's metadata ("embed") and, in a carousel, which slide it is."""
    final = []
    for i, f in enumerate(files):
        if msg.get("quicktime", True) and not is_image(f):
            f, qt_note = ensure_quicktime(f)
            if qt_note:
                safe_send({"type": "log", "line": qt_note})
        capture = msg.get("capture")
        if isinstance(capture, dict) and not is_image(f):
            extra = (extras[i] if extras and i < len(extras) else None) or {}
            tag_note = write_capture(f, {**capture, **extra})
            if tag_note:
                safe_send({"type": "log", "line": tag_note})
        final.append(f)
    send({"type": "done", "ok": True, "file": final[0] if final else None, "files": final, "note": note, "code": 0})


def cmd_download(msg):
    url = msg.get("url")
    if not url or not re.match(r"^https?://", url):
        send({"type": "done", "ok": False, "error": "Invalid URL", "code": -1})
        return

    ytdlp = which("yt-dlp")
    if not ytdlp:
        send({
            "type": "done", "ok": False, "code": -1,
            "error": "yt-dlp not found. Install it with: brew install yt-dlp",
        })
        return

    out_dir = os.path.expanduser(msg.get("outDir") or DEFAULT_OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)

    if msg.get("probe"):
        download_post(msg, ytdlp, out_dir)
        return

    argv = format_args(ytdlp, out_dir) + cookie_args(msg) + ["--no-playlist", "-o", "%(title)s.%(ext)s"]
    referer = msg.get("referer")
    if referer and re.match(r"^https?://", referer):
        argv += ["--referer", referer]
    argv.append(url)

    send({"type": "started", "argv": argv})
    code, final_file, tail, info = run_ytdlp(argv)
    if code == 0:
        finish(msg, [final_file] if final_file else [], extras=[{"embed": info} if info else None])
    else:
        send({"type": "done", "ok": False, "error": first_error(tail, code), "code": code, "tail": tail[-8:]})


# --- posts and carousels (Instagram, X, TikTok…) -----------------------------
#
# A carousel comes back from yt-dlp as a playlist with one entry per slide,
# image slides included (they simply have no formats). Every slide shares the
# post's generic title ("Video by user"), so the default "%(title)s" template
# made all slides collide on one filename.
#
# Instead: fetch the post's metadata once (-J), decide which slides to save,
# then download each chosen slide from that saved metadata (--load-info-json)
# so Instagram is only asked once.

def download_post(msg, ytdlp, out_dir):
    send({"type": "started", "argv": ["probe", msg["url"]]})
    safe_send({"type": "stage", "text": "reading post…"})
    probe = [ytdlp, "-J", "--ignore-no-formats-error", "--no-warnings"] + cookie_args(msg) + [msg["url"]]
    log(f"probe: {' '.join(probe)}")
    try:
        res = subprocess.run(probe, capture_output=True, text=True, env=ENV, timeout=180)
    except Exception as exc:  # noqa: BLE001
        send({"type": "done", "ok": False, "error": f"Could not read post: {exc}", "code": -1})
        return
    if res.returncode != 0:
        tail = [l for l in res.stderr.splitlines() if l.strip()]
        send({"type": "done", "ok": False, "error": first_error(tail, res.returncode), "code": res.returncode})
        return
    try:
        info = json.loads(res.stdout)
    except ValueError as exc:
        send({"type": "done", "ok": False, "error": f"Unreadable post metadata: {exc}", "code": -1})
        return

    entries = info.get("entries") if info.get("_type") == "playlist" else None
    if entries is None:
        entries = [info]
    entries = [e for e in entries if isinstance(e, dict)]
    n = len(entries)
    if n == 0:
        send({"type": "done", "ok": False, "error": "The post has no media yt-dlp can see.", "code": -1})
        return

    picks, note = choose_slides(entries, msg)
    log(f"post {info.get('id')}: {n} slide(s), picked {[i + 1 for i in picks]}, note={note!r}")

    owner = clean_name(info.get("channel") or info.get("uploader_id") or info.get("uploader") or info.get("extractor_key") or "post")
    post_id = clean_name(str(info.get("id") or "post"))
    files, extras, errors = [], [], []

    with tempfile.TemporaryDirectory(prefix="motion-") as tmp:
        for i in picks:
            entry = entries[i]
            base = f"{owner} - {post_id}" + (f" - {i + 1} of {n}" if n > 1 else "")
            item = f"slide {i + 1}/{n}" if n > 1 else None
            if has_video(entry):
                path = os.path.join(tmp, f"entry{i}.json")
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(entry, fh)
                argv = format_args(ytdlp, out_dir) + [
                    "--load-info-json", path,
                    "-o", base.replace("%", "%%") + ".%(ext)s",
                ]
                code, final_file, tail, _ = run_ytdlp(argv, item=item)
                if code == 0 and final_file:
                    files.append(final_file)
                    # The post says who and what; the slide may add its own fields.
                    # Which slide this is comes from the post, not the picker's guess.
                    extras.append({
                        "embed": {**embed_fields(info), **embed_fields(entry)},
                        "slide": {"index": i + 1, "count": n} if n > 1 else None,
                    })
                else:
                    errors.append(f"{item or 'video'}: {first_error(tail, code)}")
            else:
                safe_send({"type": "stage", "text": f"{item + ' · ' if item else ''}saving image…"})
                try:
                    files.append(save_image(entry, os.path.join(out_dir, base)))
                    extras.append(None)
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{item or 'image'}: {exc}")

    if not files:
        send({"type": "done", "ok": False, "error": "; ".join(errors) or "Nothing was saved.", "code": 1})
        return
    if errors:
        note = ((note + " ") if note else "") + f"{len(errors)} slide(s) failed: {errors[0]}"
    finish(msg, files, note, extras)


def embed_fields(info):
    return {k: info[k] for k in EMBED_FIELDS if info.get(k) not in (None, "", [])} if isinstance(info, dict) else {}


def has_video(entry):
    # After yt-dlp's -J pass every playable entry has a formats list (yt-dlp
    # builds one even from a bare url). Image slides keep an empty list.
    return bool(entry.get("formats"))


def choose_slides(entries, msg):
    """Return (indexes to download, note for the user).

    Signals, strongest first:
      1. the player's own CDN file, or its poster image, belongs to a slide
      2. the carousel dots the picker read, when their count matches the post
      3. ?img_index= from the post URL
      4. the dots index even if the count disagrees
    Whole-post requests take every slide. If nothing identifies the slide, every
    video slide is saved rather than guessing.
    """
    n = len(entries)
    videos = [i for i, e in enumerate(entries) if has_video(e)]

    if msg.get("whole"):
        return list(range(n)), None
    if n == 1:
        return [0], None

    media = cdn_key(msg.get("mediaUrl"))
    if media:
        for i, e in enumerate(entries):
            if any(cdn_key(f.get("url")) == media for f in e.get("formats") or []):
                return [i], None
    poster = cdn_key(msg.get("poster"))
    if poster:
        for i, e in enumerate(entries):
            if any(cdn_key(t.get("url")) == poster for t in e.get("thumbnails") or []):
                return [i], None

    slide = msg.get("slide") or {}
    dots_index, dots_count = to_int(slide.get("index")), to_int(slide.get("count"))
    url_index = to_int(msg.get("urlIndex"))
    if dots_index and dots_count == n and 1 <= dots_index <= n:
        return [dots_index - 1], None
    if url_index and 1 <= url_index <= n:
        return [url_index - 1], None
    if dots_index and 1 <= dots_index <= n:
        return [dots_index - 1], None

    if len(videos) == 1:
        return videos, None
    if videos:
        return videos, f"Couldn't tell which slide you clicked, so saved all {len(videos)} videos."
    return list(range(n)), None


def to_int(v):
    try:
        v = int(v)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def cdn_key(url):
    """CDN file identity: the file name, ignoring size/crop/signature query parameters."""
    if not url:
        return None
    path = urllib.parse.urlparse(url).path
    name = path.rsplit("/", 1)[-1]
    return name if len(name) > 12 else None


IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".heic", ".avif")


def is_image(path):
    return bool(path) and path.lower().endswith(IMAGE_EXT)


def save_image(entry, base_path):
    thumbs = [t for t in entry.get("thumbnails") or [] if t.get("url")]
    if not thumbs:
        raise RuntimeError("image slide has no image URL")
    best = max(thumbs, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))
    ext = os.path.splitext(urllib.parse.urlparse(best["url"]).path)[1].lower()
    if ext not in IMAGE_EXT:
        ext = ".jpg"
    dest = unique_path(base_path + ext)
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}
    headers.update((entry.get("http_headers") or {}))
    req = urllib.request.Request(best["url"], headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as fh:
        shutil.copyfileobj(resp, fh)
    log(f"image saved: {dest} ({best.get('width')}x{best.get('height')})")
    return dest


def unique_path(path):
    if not os.path.exists(path):
        return path
    root, ext = os.path.splitext(path)
    k = 2
    while os.path.exists(f"{root} ({k}){ext}"):
        k += 1
    return f"{root} ({k}){ext}"


def clean_name(s):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", s)
    return re.sub(r"\s+", " ", s).strip(" .")[:80] or "post"


# Codecs macOS plays natively (QuickTime Player, Finder preview, Keynote, Figma import).
QT_VIDEO = {"h264", "hevc", "mpeg4", "prores", "mjpeg"}
QT_AUDIO = {"aac", "mp3", "alac", "ac3", "eac3", "pcm_s16le", "pcm_s24le"}
QT_EXT = (".mp4", ".m4v", ".mov")


def probe_codecs(path):
    ffprobe = which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", path],
            capture_output=True, text=True, env=ENV, timeout=60,
        ).stdout
        streams = json.loads(out or "{}").get("streams", [])
    except Exception as exc:  # noqa: BLE001
        log(f"ffprobe failed: {exc}")
        return None
    return {
        "video": [s.get("codec_name", "?") for s in streams if s.get("codec_type") == "video"],
        "audio": [s.get("codec_name", "?") for s in streams if s.get("codec_type") == "audio"],
    }


def ensure_quicktime(path):
    """Return (path, note). Transcodes VP9/AV1/Opus… to H.264/AAC .mp4 when needed."""
    if not path or not os.path.isfile(path):
        return path, None
    codecs = probe_codecs(path)
    if codecs is None:
        return path, None
    video_ok = all(c in QT_VIDEO for c in codecs["video"])
    audio_ok = all(c in QT_AUDIO for c in codecs["audio"])
    ext_ok = path.lower().endswith(QT_EXT)
    if video_ok and audio_ok and ext_ok:
        return path, None

    ffmpeg = which("ffmpeg")
    if not ffmpeg:
        return path, f"Not QuickTime-compatible ({codecs}) and ffmpeg is missing to convert it"

    base, _ = os.path.splitext(path)
    tmp = base + ".qt-tmp.mp4"
    final = base + ".mp4"
    argv = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", path]
    if video_ok:
        argv += ["-c:v", "copy"]
    else:
        argv += ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"]
    if codecs["audio"]:
        argv += ["-c:a", "copy"] if audio_ok else ["-c:a", "aac", "-b:a", "192k"]
    argv += ["-movflags", "+faststart", tmp]

    safe_send({"type": "stage", "text": f"converting {'+'.join(codecs['video'] + codecs['audio'])} → H.264/AAC for QuickTime…"})
    log(f"transcode: {' '.join(argv)}")
    try:
        res = subprocess.run(argv, capture_output=True, text=True, env=ENV, timeout=3600)
    except Exception as exc:  # noqa: BLE001
        return path, f"Conversion failed to start: {exc}"
    if res.returncode != 0 or not os.path.isfile(tmp):
        log(f"transcode failed: {res.stderr[-800:]}")
        try:
            os.remove(tmp)
        except OSError:
            pass
        return path, f"Conversion failed; kept original ({codecs['video']}/{codecs['audio']})"

    try:
        if os.path.abspath(final) != os.path.abspath(path):
            os.remove(path)
        os.replace(tmp, final)
    except OSError as exc:
        return path, f"Converted but could not replace original: {exc}"
    return final, f"converted to H.264/AAC (was {'+'.join(codecs['video'] + codecs['audio'])})"


# --- the capture, in the file --------------------------------------------------
#
# Written as JSON into the comment tag (©cmt), with a stream copy: nothing is
# re-encoded. codex-motion reads it back with mediabunny when the file is
# dropped onto a board. Only MP4/MOV files carry it.
#
# ffmpeg writes a tagged copy beside the file, which then takes the file's
# place. Chrome launches the helper as its own process as far as macOS
# privacy is concerned, so in ~/Downloads it can create, rename and delete
# its own files but not replace one Chrome saved. For those, "tag" answers
# with the copy pending; the extension has Chrome remove its file, then
# "commit" moves the copy into its place (or "abort" drops it).

def capture_json(capture):
    """The capture as compact JSON, trimmed to CAPTURE_MAX."""
    capture = {k: v for k, v in capture.items() if v is not None}
    text = json.dumps(capture, ensure_ascii=False, separators=(",", ":"))
    page = capture.get("page")
    for key in ("text", "jsonLd"):
        if len(text) <= CAPTURE_MAX or not isinstance(page, dict):
            break
        page = {**page, key: "" if key == "text" else []}
        capture = {**capture, "page": page}
        text = json.dumps(capture, ensure_ascii=False, separators=(",", ":"))
    return text if len(text) <= CAPTURE_MAX else None


def tagged_path(path):
    """Where the tagged copy of `path` is written."""
    base, ext = os.path.splitext(path)
    return base + ".tag-tmp" + ext


def remove_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass


def tag_copy(path, capture):
    """Writes a tagged copy of the file beside it. Returns (copy, None), or (None, note)."""
    ffmpeg = which("ffmpeg")
    if not ffmpeg:
        return None, "Kept the file without its page details: ffmpeg is missing"
    text = capture_json(capture)
    if not text:
        return None, "Kept the file without its page details: they were too large"
    tmp = tagged_path(path)
    # Some files carry data tracks (timecode) a copy can't remux; video and audio alone always can.
    for maps in (["-map", "0"], ["-map", "0:v", "-map", "0:a?"]):
        argv = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", path, *maps,
                "-c", "copy", "-map_metadata", "0", "-metadata", f"comment={text}", "-movflags", "+faststart", tmp]
        try:
            res = subprocess.run(argv, capture_output=True, text=True, env=ENV, timeout=600)
        except Exception as exc:  # noqa: BLE001
            remove_quietly(tmp)
            return None, f"Kept the file without its page details: {exc}"
        if res.returncode == 0 and os.path.isfile(tmp):
            log(f"capture written: {tmp} ({len(text)} chars)")
            return tmp, None
        log(f"capture write failed ({' '.join(maps)}): {res.stderr[-600:]}")
    remove_quietly(tmp)
    return None, "Kept the file without its page details: ffmpeg couldn't read or rewrite it"


def write_capture(path, capture):
    """Writes the capture into a file the helper saved. Returns a note when it couldn't."""
    if not path or not os.path.isfile(path) or not path.lower().endswith(QT_EXT):
        return None
    tmp, note = tag_copy(path, capture)
    if not tmp:
        return note
    try:
        os.replace(tmp, path)
    except OSError as exc:
        remove_quietly(tmp)
        return f"Kept the file without its page details: {exc.strerror or exc}"
    return None


def cmd_tag(msg):
    """Writes the capture into a file Chrome downloaded, or leaves the tagged
    copy pending when the helper may not replace Chrome's file."""
    path = msg.get("file")
    capture = msg.get("capture")
    if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
        send({"type": "done", "ok": False, "error": "No such file", "code": -1})
        return
    if not path.lower().endswith(QT_EXT):
        send({"type": "done", "ok": False, "error": "Only MP4 and MOV files can carry page details", "code": -1})
        return
    if not isinstance(capture, dict):
        send({"type": "done", "ok": False, "error": "No capture to write", "code": -1})
        return
    tmp, note = tag_copy(path, capture)
    if not tmp:
        send({"type": "done", "ok": False, "file": path, "error": note, "code": 1})
        return
    try:
        os.replace(tmp, path)
    except PermissionError:
        log(f"may not replace {path}; the extension removes it, then commits {tmp}")
        send({"type": "done", "ok": True, "file": path, "pending": tmp, "code": 0})
        return
    except OSError as exc:
        remove_quietly(tmp)
        send({"type": "done", "ok": False, "file": path, "error": f"Kept the file without its page details: {exc.strerror or exc}", "code": 1})
        return
    send({"type": "done", "ok": True, "file": path, "code": 0})


def pending_pair(msg):
    """The (copy, file) a commit or abort names, if the copy is the one tag left for that file."""
    path, tmp = msg.get("file"), msg.get("tmp")
    if not isinstance(path, str) or not isinstance(tmp, str) or not os.path.isabs(path):
        return None
    if tmp != tagged_path(path) or not os.path.isfile(tmp):
        return None
    return tmp, path


def cmd_commit(msg):
    """Moves a pending tagged copy into the place Chrome's file left."""
    pair = pending_pair(msg)
    if not pair:
        send({"type": "done", "ok": False, "error": "No tagged copy waiting for that file", "code": -1})
        return
    tmp, path = pair
    if os.path.exists(path):
        send({"type": "done", "ok": False, "error": "The original is still there", "code": -1})
        return
    try:
        os.rename(tmp, path)
    except OSError:
        # A copy is a new file, which the helper may always make.
        try:
            shutil.copyfile(tmp, path)
            remove_quietly(tmp)
        except OSError as exc:
            send({"type": "done", "ok": False, "file": tmp, "error": f"The tagged copy is at {os.path.basename(tmp)}: {exc.strerror or exc}", "code": 1})
            return
    log(f"committed {path}")
    send({"type": "done", "ok": True, "file": path, "code": 0})


def cmd_abort(msg):
    """Drops a pending tagged copy (Chrome couldn't remove its file)."""
    pair = pending_pair(msg)
    if pair:
        remove_quietly(pair[0])
    send({"type": "done", "ok": True, "code": 0})


def safe_send(obj):
    # If the extension side has disconnected, stdout is a broken pipe.
    # Keep going so the download itself still completes.
    try:
        send(obj)
    except (BrokenPipeError, OSError):
        pass


def main():
    log(
        f"start python={sys.version.split()[0]} exe={sys.executable} script={os.path.abspath(__file__)} "
        f"cwd={os.getcwd()} PATH={ENV['PATH']}"
    )
    while True:
        try:
            msg = read_message()
        except Exception as exc:  # noqa: BLE001
            log(f"bad message: {exc}")
            safe_send({"type": "done", "ok": False, "error": f"Bad message: {exc}", "code": -1})
            continue
        if msg is None:
            log("stdin closed, exiting")
            return
        cmd = msg.get("cmd")
        log(f"← {json.dumps(msg)[:400]}")
        if cmd == "ping":
            cmd_ping()
        elif cmd == "download":
            cmd_download(msg)
        elif cmd == "tag":
            cmd_tag(msg)
        elif cmd == "commit":
            cmd_commit(msg)
        elif cmd == "abort":
            cmd_abort(msg)
        else:
            safe_send({"type": "done", "ok": False, "error": f"Unknown command: {cmd}", "code": -1})


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        log("pipe closed")
    except Exception:  # noqa: BLE001
        log("CRASH\n" + traceback.format_exc())
        safe_send({"type": "done", "ok": False, "error": f"Helper crashed, see {LOG_FILE}", "code": -1})
        sys.exit(1)
