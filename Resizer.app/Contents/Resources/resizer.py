#!/usr/bin/env python3
"""
Resizer — vertical video -> 16:9 + 1:1 with a blurred background.

Rendering is done by a native ffmpeg process (hardware encoders when available),
the browser is only a UI running on localhost.

  python3 resizer.py                  # start the UI and open the browser
  python3 resizer.py a.mp4 b.mov -b 5 # render from the terminal, no UI
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
BASE = Path(os.environ.get("RESIZER_BASE") or ROOT)
WORK_DIR = BASE / "work"
UPLOAD_DIR = WORK_DIR / "uploads"
OUTPUT_DIR = BASE / "output"

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

# Width of the tiny frame the background is blurred at. Blurring a 160px frame
# and upscaling it is ~100x cheaper than blurring the full-resolution frame and
# looks the same, which is the main reason this renders fast.
BG_WORK_WIDTH = 160

FORMATS = {
    "16x9": {"label": "16:9", "aspect": (16, 9)},
    "1x1": {"label": "1:1", "aspect": (1, 1)},
}

# Tried in this order for "auto". Name -> human label.
ENCODERS = {
    "h264": [
        ("h264_videotoolbox", "Apple VideoToolbox"),
        ("h264_nvenc", "NVIDIA NVENC"),
        ("h264_qsv", "Intel Quick Sync"),
        ("h264_amf", "AMD AMF"),
        ("h264_vaapi", "VAAPI"),
        ("libx264", "CPU (x264)"),
    ],
    "hevc": [
        ("hevc_videotoolbox", "Apple VideoToolbox"),
        ("hevc_nvenc", "NVIDIA NVENC"),
        ("hevc_qsv", "Intel Quick Sync"),
        ("hevc_amf", "AMD AMF"),
        ("hevc_vaapi", "VAAPI"),
        ("libx265", "CPU (x265)"),
    ],
}
SOFTWARE = {"libx264", "libx265"}
VAAPI_DEVICE = "/dev/dri/renderD128"
COPYABLE_AUDIO = {"aac", "mp3", "alac", "ac3", "eac3"}


# --------------------------------------------------------------------------- #
# ffmpeg helpers
# --------------------------------------------------------------------------- #

def check_ffmpeg() -> None:
    for tool in (FFMPEG, FFPROBE):
        if not shutil.which(tool):
            sys.exit(
                f"Не знайдено {Path(tool).name}. Встановіть ffmpeg:\n"
                "  macOS:   brew install ffmpeg\n"
                "  Windows: winget install Gyan.FFmpeg\n"
                "  Linux:   sudo apt install ffmpeg"
            )


def _encoder_args_probe(enc: str) -> list[str]:
    if enc.endswith("_vaapi"):
        return ["-vaapi_device", VAAPI_DEVICE, "-f", "lavfi", "-i", "color=s=256x256:d=0.2",
                "-vf", "format=nv12,hwupload", "-c:v", enc]
    return ["-f", "lavfi", "-i", "color=s=256x256:d=0.2", "-pix_fmt", "yuv420p", "-c:v", enc]


_encoder_cache: dict[str, list[dict]] | None = None
_encoder_lock = threading.Lock()


def detect_encoders() -> dict[str, list[dict]]:
    """Return encoders that actually work on this machine (a real test encode)."""
    global _encoder_cache
    with _encoder_lock:
        if _encoder_cache is not None:
            return _encoder_cache
        try:
            listed = subprocess.run([FFMPEG, "-hide_banner", "-encoders"],
                                    capture_output=True, text=True, timeout=20).stdout
        except Exception:
            listed = ""
        result: dict[str, list[dict]] = {}
        for codec, candidates in ENCODERS.items():
            ok = []
            for enc, label in candidates:
                if not re.search(rf"\s{enc}\s", listed):
                    continue
                cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", *_encoder_args_probe(enc),
                       "-frames:v", "3", "-f", "null", "-"]
                try:
                    r = subprocess.run(cmd, capture_output=True, timeout=20)
                except Exception:
                    continue
                if r.returncode == 0:
                    ok.append({"id": enc, "label": label, "hardware": enc not in SOFTWARE})
            result[codec] = ok
        _encoder_cache = result
        return result


def pick_encoder(codec: str, requested: str | None) -> str:
    available = [e["id"] for e in detect_encoders().get(codec, [])]
    if requested and requested != "auto" and requested in available:
        return requested
    if available:
        return available[0]
    return "libx264" if codec == "h264" else "libx265"


def probe(path: Path) -> dict:
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise ValueError("Не вдалося прочитати відео: " + (r.stderr.strip() or "невідомий формат"))
    data = json.loads(r.stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if not video:
        raise ValueError("У файлі немає відеодоріжки")
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)

    w, h = int(video.get("width", 0)), int(video.get("height", 0))
    rotation = 0
    for sd in video.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    rotation = rotation or int(float((video.get("tags") or {}).get("rotate", 0) or 0))
    if abs(rotation) % 180 == 90:
        w, h = h, w

    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
    fps = 0.0
    try:
        num, den = (video.get("avg_frame_rate") or "0/1").split("/")
        fps = float(num) / float(den) if float(den) else 0.0
    except ValueError:
        pass
    return {
        "width": w,
        "height": h,
        "duration": duration,
        "fps": round(fps, 2),
        "video_codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name") if audio else None,
        "size": path.stat().st_size,
    }


@dataclass
class RenderOptions:
    bitrate: float = 5.0          # Mbps
    height: int = 1080            # output height (square is height x height)
    formats: tuple[str, ...] = ("16x9", "1x1")
    blur: int = 50                # 0..100
    dim: int = 30                 # 0..80, % darker
    codec: str = "h264"           # h264 | hevc
    encoder: str = "auto"
    hw_decode: bool = True

    @classmethod
    def from_dict(cls, d: dict) -> "RenderOptions":
        o = cls()
        o.bitrate = max(0.5, min(100.0, float(d.get("bitrate", o.bitrate))))
        o.height = int(d.get("height", o.height))
        if o.height not in (720, 1080, 1440, 2160):
            o.height = 1080
        fm = tuple(f for f in d.get("formats", o.formats) if f in FORMATS)
        o.formats = fm or o.formats
        o.blur = max(0, min(100, int(d.get("blur", o.blur))))
        o.dim = max(0, min(80, int(d.get("dim", o.dim))))
        o.codec = d.get("codec", o.codec) if d.get("codec") in ENCODERS else "h264"
        o.encoder = str(d.get("encoder", "auto"))
        o.hw_decode = bool(d.get("hw_decode", True))
        return o


def out_size(fmt: str, height: int) -> tuple[int, int]:
    aw, ah = FORMATS[fmt]["aspect"]
    w = round(height * aw / ah / 2) * 2
    return w, height


def build_filter(info: dict, opts: RenderOptions, vaapi: bool) -> str:
    """
    One decode -> shared foreground scale + one shared tiny blurred background,
    then per-format crop/upscale/overlay. Labels [o0], [o1]... are the outputs.
    """
    n = len(opts.formats)
    src_w, src_h = info["width"] or 1080, info["height"] or 1920
    radius = 1 + round(opts.blur / 100 * 11)             # boxblur radius on the 160px frame
    level = 1 - opts.dim / 100
    tail = "format=nv12,hwupload" if vaapi else "format=yuv420p"

    parts = [f"[0:v]split=2[bgsrc][fgsrc]"]
    # Background: shrink to 160px wide, blur, darken. Only once for all outputs.
    bg_h = max(2, round(BG_WORK_WIDTH * src_h / src_w / 2) * 2)
    parts.append(
        f"[bgsrc]scale={BG_WORK_WIDTH}:{bg_h}:flags=bilinear,"
        f"boxblur=luma_radius={radius}:luma_power=2:chroma_radius={radius}:chroma_power=2,"
        f"colorlevels=romax={level:.3f}:gomax={level:.3f}:bomax={level:.3f},"
        f"split={n}" + "".join(f"[bg{i}]" for i in range(n))
    )

    vertical = src_w <= src_h
    if vertical:
        # Full-height foreground, identical for every output -> scale once.
        parts.append(f"[fgsrc]scale=-2:{opts.height}:flags=bicubic,split={n}"
                     + "".join(f"[fg{i}]" for i in range(n)))
    else:
        parts.append(f"[fgsrc]split={n}" + "".join(f"[fr{i}]" for i in range(n)))

    for i, fmt in enumerate(opts.formats):
        W, H = out_size(fmt, opts.height)
        # Cover-crop the tiny background to the output aspect, then upscale.
        cw = BG_WORK_WIDTH
        ch = round(cw * H / W)
        if ch > bg_h:
            ch = bg_h
            cw = round(ch * W / H)
        parts.append(f"[bg{i}]crop={cw}:{ch},scale={W}:{H}:flags=bicubic[b{i}]")
        if not vertical:
            parts.append(f"[fr{i}]scale={W}:{H}:force_original_aspect_ratio=decrease:"
                         f"flags=bicubic,scale=trunc(iw/2)*2:trunc(ih/2)*2[fg{i}]")
        parts.append(f"[b{i}][fg{i}]overlay=(W-w)/2:(H-h)/2,setsar=1,{tail}[o{i}]")
    return ";".join(parts)


def encoder_args(enc: str, mbps: float) -> list[str]:
    b = f"{mbps:g}M"
    maxrate = f"{mbps * 1.5:g}M"
    bufsize = f"{mbps * 2:g}M"
    rate = ["-b:v", b, "-maxrate", maxrate, "-bufsize", bufsize]
    if enc == "libx264":
        return ["-c:v", enc, "-preset", "veryfast", *rate]
    if enc == "libx265":
        return ["-c:v", enc, "-preset", "faster", *rate, "-x265-params", "log-level=error"]
    if enc.endswith("_videotoolbox"):
        return ["-c:v", enc, "-b:v", b, "-maxrate", maxrate, "-bufsize", bufsize,
                "-realtime", "0", "-prio_speed", "1"]
    if enc.endswith("_nvenc"):
        return ["-c:v", enc, "-preset", "p4", "-rc", "vbr", *rate]
    if enc.endswith("_qsv"):
        return ["-c:v", enc, "-preset", "faster", *rate]
    if enc.endswith("_amf"):
        return ["-c:v", enc, "-quality", "speed", "-rc", "vbr_peak", *rate]
    return ["-c:v", enc, *rate]


def clean_name(name: str) -> str:
    """Make a user-typed name safe for macOS/Windows/Linux file systems."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:150] or "video"


def unique_path(p: Path) -> Path:
    if not p.exists():
        return p
    i = 2
    while True:
        c = p.with_name(f"{p.stem}_{i}{p.suffix}")
        if not c.exists():
            return c
        i += 1


def build_command(src: Path, info: dict, opts: RenderOptions, enc: str, hw_decode: bool,
                  outputs: list[Path]) -> list[str]:
    vaapi = enc.endswith("_vaapi")
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
           "-progress", "pipe:1", "-nostats"]
    if vaapi:
        cmd += ["-vaapi_device", VAAPI_DEVICE]
    if hw_decode and not vaapi:
        cmd += ["-hwaccel", "auto"]
    cmd += ["-i", str(src), "-filter_complex", build_filter(info, opts, vaapi)]

    has_audio = info.get("audio_codec") is not None
    copy_audio = info.get("audio_codec") in COPYABLE_AUDIO
    extra = encoder_args(enc, opts.bitrate)
    if opts.codec == "hevc":
        extra += ["-tag:v", "hvc1"]
    for i, out in enumerate(outputs):
        cmd += ["-map", f"[o{i}]"]
        if has_audio:
            cmd += ["-map", "0:a:0"]
            cmd += ["-c:a", "copy"] if copy_audio else ["-c:a", "aac", "-b:a", "192k"]
        cmd += [*extra, "-movflags", "+faststart", str(out)]
    return cmd


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #

@dataclass
class Job:
    id: str
    src: Path
    name: str
    info: dict
    opts: RenderOptions
    out_name: str = ""              # output base name; formats are prefixed: 16x9_<out_name>.mp4
    status: str = "queued"          # queued | running | done | error | cancelled
    progress: float = 0.0
    speed: float = 0.0
    eta: float | None = None
    started: float = 0.0
    elapsed: float = 0.0
    encoder: str = ""
    error: str = ""
    outputs: list[dict] = field(default_factory=list)
    proc: subprocess.Popen | None = None
    cancelled: bool = False

    def public(self) -> dict:
        return {
            "id": self.id, "name": self.name, "status": self.status,
            "progress": round(self.progress, 4), "speed": round(self.speed, 2),
            "eta": None if self.eta is None else round(self.eta),
            "elapsed": round(self.elapsed if self.status != "running" else time.time() - self.started, 1),
            "encoder": self.encoder, "error": self.error, "outputs": self.outputs,
        }


JOBS: dict[str, Job] = {}


def run_job(job: Job, on_progress=None) -> None:
    """Run ffmpeg for a job. Falls back: hw decode off -> CPU encoder."""
    job.status = "running"
    job.started = time.time()
    stem = clean_name(job.out_name or Path(job.name).stem)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    enc = pick_encoder(job.opts.codec, job.opts.encoder)
    soft = "libx264" if job.opts.codec == "h264" else "libx265"
    attempts: list[tuple[str, bool]] = []
    for a in [(enc, job.opts.hw_decode), (enc, False), (soft, False)]:
        if a not in attempts:
            attempts.append(a)

    duration = job.info.get("duration") or 0
    last_err = ""
    for enc_try, hwdec in attempts:
        outs = [unique_path(OUTPUT_DIR / f"{fmt}_{stem}.mp4") for fmt in job.opts.formats]
        cmd = build_command(job.src, job.info, job.opts, enc_try, hwdec, outs)
        job.encoder = enc_try
        job.progress = 0.0
        err_lines: list[str] = []
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, bufsize=1)
        job.proc = proc

        def read_err():
            for line in proc.stderr:  # type: ignore[union-attr]
                err_lines.append(line.rstrip())
                del err_lines[:-40]
        t = threading.Thread(target=read_err, daemon=True)
        t.start()

        for line in proc.stdout:  # type: ignore[union-attr]
            key, _, val = line.strip().partition("=")
            if key == "out_time_us" and val.lstrip("-").isdigit() and duration:
                job.progress = max(0.0, min(0.999, int(val) / 1e6 / duration))
            elif key == "speed":
                try:
                    job.speed = float(val.rstrip("x"))
                except ValueError:
                    pass
            elif key == "progress":
                el = time.time() - job.started
                if job.progress > 0.01:
                    job.eta = el / job.progress - el
                if on_progress:
                    on_progress(job)
        proc.wait()
        t.join(timeout=2)
        job.proc = None

        if job.cancelled:
            for o in outs:
                o.unlink(missing_ok=True)
            job.status = "cancelled"
            job.elapsed = time.time() - job.started
            return
        if proc.returncode == 0:
            job.progress = 1.0
            job.eta = 0
            job.elapsed = time.time() - job.started
            job.outputs = [{
                "format": fmt, "label": FORMATS[fmt]["label"], "file": o.name,
                "size": o.stat().st_size, "path": str(o),
                "url": "/media/out/" + quote(o.name),
                "width": out_size(fmt, job.opts.height)[0], "height": job.opts.height,
            } for fmt, o in zip(job.opts.formats, outs)]
            job.status = "done"
            if on_progress:
                on_progress(job)
            return
        for o in outs:
            o.unlink(missing_ok=True)
        last_err = "\n".join(err_lines[-12:]) or f"ffmpeg завершився з кодом {proc.returncode}"

    job.status = "error"
    job.error = last_err
    job.elapsed = time.time() - job.started


# --------------------------------------------------------------------------- #
# HTTP server
# --------------------------------------------------------------------------- #

UPLOADS: dict[str, dict] = {}
LAST_SEEN = time.time()


class Handler(BaseHTTPRequestHandler):
    server_version = "Resizer/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def parse_request(self):
        global LAST_SEEN
        LAST_SEEN = time.time()
        return super().parse_request()

    # ---- helpers ---------------------------------------------------------- #
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return {}

    def send_file(self, path: Path, download_name: str | None = None):
        if not path.is_file():
            return self.send_json({"error": "not found"}, 404)
        size = path.stat().st_size
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download_name:
            self.send_header("Content-Disposition",
                             f"attachment; filename*=UTF-8''{quote(download_name)}")
        if path.suffix in (".html", ".js", ".css"):
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as f:
            f.seek(start)
            remaining = length
            try:
                while remaining > 0:
                    chunk = f.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    # ---- routes ----------------------------------------------------------- #
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        p = unquote(url.path)
        q = parse_qs(url.query)

        if p == "/api/ping":
            return self.send_json({"app": "resizer"})
        if p == "/api/info":
            enc = detect_encoders()
            return self.send_json({
                "encoders": enc,
                "output_dir": str(OUTPUT_DIR),
                "ffmpeg": FFMPEG,
            })
        if p.startswith("/api/jobs/"):
            job = JOBS.get(p.rsplit("/", 1)[-1])
            return self.send_json(job.public() if job else {"error": "not found"}, 200 if job else 404)
        if p.startswith("/media/upload/"):
            up = UPLOADS.get(p.rsplit("/", 1)[-1])
            return self.send_file(Path(up["path"])) if up else self.send_json({"error": "not found"}, 404)
        if p.startswith("/media/out/"):
            name = Path(p[len("/media/out/"):]).name
            dl = name if "download" in q else None
            return self.send_file(OUTPUT_DIR / name, dl)

        rel = "index.html" if p in ("/", "") else p.lstrip("/")
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR.resolve() not in target.parents and target != WEB_DIR.resolve():
            return self.send_json({"error": "forbidden"}, 403)
        return self.send_file(target)

    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/api/upload":
            return self.handle_upload()
        if p == "/api/render":
            return self.handle_render()
        if p.startswith("/api/jobs/") and p.endswith("/cancel"):
            job = JOBS.get(p.split("/")[3])
            if job:
                job.cancelled = True
                if job.proc and job.proc.poll() is None:
                    job.proc.terminate()
            return self.send_json({"ok": bool(job)})
        if p == "/api/open-folder":
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            open_in_file_manager(OUTPUT_DIR)
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)

    def handle_upload(self):
        length = int(self.headers.get("Content-Length") or 0)
        name = unquote(self.headers.get("X-Filename") or "video.mp4")
        name = Path(name).name or "video.mp4"
        fid = uuid.uuid4().hex[:12]
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        dest = UPLOAD_DIR / f"{fid}{Path(name).suffix.lower() or '.mp4'}"
        remaining = length
        with dest.open("wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(4 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        if remaining:
            dest.unlink(missing_ok=True)
            return self.send_json({"error": "Завантаження перервано"}, 400)
        try:
            info = probe(dest)
        except ValueError as e:
            dest.unlink(missing_ok=True)
            return self.send_json({"error": str(e)}, 400)
        UPLOADS[fid] = {"path": str(dest), "name": name, "info": info}
        return self.send_json({"id": fid, "name": name, "info": info,
                               "url": f"/media/upload/{fid}"})

    def handle_render(self):
        body = self.read_json()
        up = UPLOADS.get(body.get("id", ""))
        if not up:
            return self.send_json({"error": "Файл не знайдено, завантажте його ще раз"}, 404)
        opts = RenderOptions.from_dict(body)
        job = Job(id=uuid.uuid4().hex[:12], src=Path(up["path"]), name=up["name"],
                  info=up["info"], opts=opts, out_name=str(body.get("name") or ""))
        JOBS[job.id] = job
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
        return self.send_json(job.public())


def open_in_file_manager(path: Path) -> None:
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        elif os.name == "nt":
            os.startfile(str(path))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception:
        pass


def serve(port: int, open_browser: bool, idle_exit: int = 0) -> None:
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
    threading.Thread(target=detect_encoders, daemon=True).start()
    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    if not httpd:
        sys.exit("Не вдалося відкрити порт")
    url = f"http://127.0.0.1:{port}"
    print(f"\n  Resizer працює: {url}\n  Готові файли:   {OUTPUT_DIR}\n  Зупинити:       Ctrl+C\n")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    if idle_exit > 0:
        # Launched from Resizer.app: no terminal to Ctrl+C, so stop by ourselves
        # once the browser tab is gone (it pings every 15 s) and nothing renders.
        def watchdog():
            while True:
                time.sleep(10)
                busy = any(j.status in ("queued", "running") for j in JOBS.values())
                if not busy and time.time() - LAST_SEEN > idle_exit:
                    httpd.shutdown()
                    return
        threading.Thread(target=watchdog, daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for job in JOBS.values():
            if job.proc and job.proc.poll() is None:
                job.proc.terminate()
        shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
        print("\n  Зупинено.")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def fmt_time(s: float | None) -> str:
    if s is None:
        return "--:--"
    s = int(s)
    return f"{s // 60:02d}:{s % 60:02d}" if s < 3600 else f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def cli(args) -> None:
    global OUTPUT_DIR
    if args.out:
        OUTPUT_DIR = Path(args.out).expanduser().resolve()
    formats = tuple(f.strip() for f in args.formats.split(",") if f.strip())
    bad = [f for f in formats if f not in FORMATS]
    if bad:
        sys.exit(f"Невідомий формат: {', '.join(bad)} (доступні: {', '.join(FORMATS)})")
    opts = RenderOptions(bitrate=args.bitrate, height=args.res, formats=formats, blur=args.blur,
                         dim=args.dim, codec=args.codec, encoder=args.encoder,
                         hw_decode=not args.no_hwdec)
    enc = pick_encoder(opts.codec, opts.encoder)
    print(f"Енкодер: {enc}   Бітрейт: {opts.bitrate:g} Мбіт/с   Висота: {opts.height}p   "
          f"Формати: {', '.join(FORMATS[f]['label'] for f in formats)}")
    failed = 0
    for src in args.inputs:
        path = Path(src).expanduser()
        if not path.is_file():
            print(f"✗ {src}: файл не знайдено")
            failed += 1
            continue
        try:
            info = probe(path)
        except ValueError as e:
            print(f"✗ {path.name}: {e}")
            failed += 1
            continue
        out_name = args.name if args.name and len(args.inputs) == 1 else ""
        job = Job(id="cli", src=path, name=path.name, info=info, opts=opts, out_name=out_name)

        def show(j: Job):
            bar = int(j.progress * 30)
            sys.stdout.write(f"\r  {path.name[:32]:32} [{'█' * bar}{'░' * (30 - bar)}] "
                             f"{j.progress * 100:5.1f}%  {j.speed:4.1f}x  ETA {fmt_time(j.eta)} ")
            sys.stdout.flush()

        try:
            run_job(job, show)
        except KeyboardInterrupt:
            job.cancelled = True
            if job.proc:
                job.proc.terminate()
            print("\nСкасовано.")
            sys.exit(130)
        print()
        if job.status == "done":
            for o in job.outputs:
                print(f"  ✓ {o['label']:5} {o['path']}  ({o['size'] / 1e6:.1f} МБ)")
            print(f"  Час: {fmt_time(job.elapsed)} ({job.encoder})")
        else:
            failed += 1
            print(f"  ✗ Помилка:\n{job.error}")
    sys.exit(1 if failed else 0)


def main() -> None:
    ap = argparse.ArgumentParser(description="Вертикальне відео → 16:9 і 1:1 з розмитим фоном")
    ap.add_argument("inputs", nargs="*", help="відеофайли (без них запускається інтерфейс)")
    ap.add_argument("-b", "--bitrate", type=float, default=5.0, help="бітрейт, Мбіт/с (5)")
    ap.add_argument("-r", "--res", type=int, default=1080, choices=[720, 1080, 1440, 2160],
                    help="висота виходу (1080)")
    ap.add_argument("-f", "--formats", default="16x9,1x1", help="16x9,1x1")
    ap.add_argument("--blur", type=int, default=50, help="сила блюру 0-100 (50)")
    ap.add_argument("--dim", type=int, default=30, help="затемнення фону 0-80%% (30)")
    ap.add_argument("--codec", choices=list(ENCODERS), default="h264")
    ap.add_argument("--encoder", default="auto", help="auto або назва ffmpeg-енкодера")
    ap.add_argument("--no-hwdec", action="store_true", help="не використовувати апаратне декодування")
    ap.add_argument("-n", "--name", help="назва вихідних файлів (лише для одного файлу): 16x9_<назва>.mp4")
    ap.add_argument("-o", "--out", help="папка для результатів (./output)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--idle-exit", type=int, default=0,
                    help="зупинити сервер через N секунд після закриття вкладки (0 — ніколи)")
    ap.add_argument("--work", help="папка для тимчасових файлів (./work)")
    ap.add_argument("--list-encoders", action="store_true")
    args = ap.parse_args()

    global OUTPUT_DIR, WORK_DIR, UPLOAD_DIR
    if args.work:
        WORK_DIR = Path(args.work).expanduser().resolve()
        UPLOAD_DIR = WORK_DIR / "uploads"
    check_ffmpeg()
    if args.list_encoders:
        for codec, encs in detect_encoders().items():
            print(f"{codec}: " + (", ".join(f"{e['id']} ({e['label']})" for e in encs) or "—"))
        return
    if args.inputs:
        cli(args)
    else:
        if args.out:
            OUTPUT_DIR = Path(args.out).expanduser().resolve()
        serve(args.port, not args.no_browser, args.idle_exit)


if __name__ == "__main__":
    main()
