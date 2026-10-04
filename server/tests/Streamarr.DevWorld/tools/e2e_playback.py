#!/usr/bin/env python3
"""End-to-end check of the viewer playback API (/api/v1/viewer/playback) against a running Dev World.

Usage: e2e_playback.py [base_url] [--hlssim PATH/Streamarr.Tools.HlsSim.dll] [--json FILE] [--quick]
Default base_url http://127.0.0.1:39310. Needs ffprobe on PATH; HLS URLs are also played with hlssim when given.
Plays every variant of the media matrix with device profiles for Android TV (ExoPlayer + libVLC), Apple TV (AVPlayer +
VLCKit), Chrome (hls.js) and Safari, then the dead-release fallback, gast (remux ok, transcode blocked, one stream), the
kind age gate, switching audio/subtitles mid-play, heartbeats via watch progress, ownership and stop.
Exits non-zero when any check fails.
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ARGS = sys.argv[1:]
if ARGS and ARGS[0] in ("-h", "--help"):
    print(__doc__)
    sys.exit(0)


def option(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        value = ARGS[i + 1]
        del ARGS[i:i + 2]
        return value
    return default


HLSSIM = option("--hlssim")
JSON_OUT = option("--json")
QUICK = "--quick" in ARGS
if QUICK:
    ARGS.remove("--quick")
BASE = (ARGS[0] if ARGS else "http://127.0.0.1:39310").rstrip("/")
failures = []
results = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" - {detail}" if detail else ""), flush=True)
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    if not ok:
        failures.append(name)
    return ok


def http(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode())
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw, status = resp.read(), resp.status
    except urllib.error.HTTPError as err:
        raw, status = err.read(), err.code
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, raw


def login(user, device, password="streamarr"):
    status, body = http("POST", "/api/v1/viewer/auth/login",
                        {"login": user, "password": password, "deviceName": device, "clientName": "e2e-playback"})
    if status == 200 and body.get("status") == "mfa_required":
        _, code = http("GET", f"/devworld/totp/{user}")
        status, body = http("POST", "/api/v1/viewer/auth/login/second-factor",
                            {"mfaToken": body["mfaToken"], "code": code["code"] if isinstance(code, dict) else code,
                             "deviceName": device, "clientName": "e2e-playback"})
    assert status == 200, f"login {user}: {status} {body}"
    return body["session"]["accessToken"]


# Device profiles as the client's media-caps module will send them (PLAN §2 / M1.3 DeviceProfile).
ANDROID_TV = {"platform": "androidtv", "vlcAvailable": True, "engines": [
    {"engine": "native", "hls": True, "maxAudioChannels": 6, "containers": ["mp4", "mkv", "webm", "ts"],
     "videoCodecs": [{"codec": "h264", "maxHeight": 2160}, {"codec": "hevc", "maxBitDepth": 10, "hdrFormats": ["hdr10", "hlg"]},
                     {"codec": "av1", "maxBitDepth": 10, "hdrFormats": ["hdr10"]}, {"codec": "vp9", "maxBitDepth": 10}],
     "audioCodecs": [{"codec": "aac"}, {"codec": "mp3"}, {"codec": "opus"}, {"codec": "flac"},
                     {"codec": "ac3", "passthrough": True}, {"codec": "eac3", "passthrough": True}, {"codec": "dts", "passthrough": True}],
     "subtitleFormats": ["srt", "ass", "ssa", "webvtt", "pgs", "vobsub", "dvbsub"]},
    {"engine": "vlc", "hls": True, "maxAudioChannels": 6, "containers": ["mkv", "mp4", "ts", "mpeg", "avi", "webm"],
     "videoCodecs": [{"codec": c} for c in ["h264", "hevc", "av1", "vp9", "mpeg2video", "mpeg4", "vc1"]],
     "audioCodecs": [{"codec": c} for c in ["aac", "ac3", "eac3", "truehd", "dts", "opus", "flac", "mp3", "mp2"]],
     "subtitleFormats": ["srt", "ass", "webvtt", "pgs", "vobsub"]}]}
APPLE_TV = {"platform": "tvos", "vlcAvailable": True, "engines": [
    {"engine": "native", "hls": True, "maxAudioChannels": 6, "containers": ["mp4"],
     "videoCodecs": [{"codec": "h264", "maxHeight": 2160}, {"codec": "hevc", "maxBitDepth": 10, "hdrFormats": ["hdr10", "hlg", "dolbyvision"]}],
     "audioCodecs": [{"codec": "aac"}, {"codec": "ac3"}, {"codec": "eac3"}, {"codec": "flac"}, {"codec": "mp3"}],
     "subtitleFormats": ["webvtt", "mov_text"]}]}
CHROME = {"platform": "web", "vlcAvailable": False, "engines": [
    {"engine": "web", "hls": True, "maxAudioChannels": 2, "containers": ["mp4", "webm"],
     "videoCodecs": [{"codec": "h264"}, {"codec": "vp9"}, {"codec": "av1", "maxBitDepth": 10}, {"codec": "hevc", "maxBitDepth": 10, "hdrFormats": ["hdr10"]}],
     "audioCodecs": [{"codec": "aac"}, {"codec": "mp3"}, {"codec": "opus"}, {"codec": "flac"}],
     "subtitleFormats": ["webvtt"]}]}
SAFARI = {"platform": "web", "vlcAvailable": False, "engines": [
    {"engine": "web", "hls": True, "maxAudioChannels": 2, "containers": ["mp4"],
     "videoCodecs": [{"codec": "h264"}, {"codec": "hevc", "maxBitDepth": 10, "hdrFormats": ["hdr10", "hlg", "dolbyvision"]}],
     "audioCodecs": [{"codec": "aac"}, {"codec": "ac3"}, {"codec": "eac3"}, {"codec": "mp3"}, {"codec": "flac"}],
     "subtitleFormats": ["webvtt"]}]}
# iPhone simulator as reported by the I1 media-caps module: H.264 1080p 8-bit SDR only, so every HEVC title transcodes.
IPHONE_SIM = {"platform": "ios", "vlcAvailable": False, "engines": [
    {"engine": "native", "hls": True, "maxAudioChannels": 2, "containers": ["mp4"],
     "videoCodecs": [{"codec": "h264", "maxHeight": 1080, "maxBitDepth": 8}],
     "audioCodecs": [{"codec": "aac"}, {"codec": "ac3"}, {"codec": "eac3"}, {"codec": "mp3"}],
     "subtitleFormats": ["webvtt"]}]}
CHROME_HINTS = "videoCodecs=h264,vp9,av1,hevc&audioCodecs=aac,mp3,opus,flac&containers=mp4,webm&supports10Bit=true&maxAudioChannels=2"
DEVICES = {"androidtv": ANDROID_TV, "appletv": APPLE_TV, "chrome": CHROME, "safari": SAFARI}

# Expected (method, engine) per variant and device for anna (transcoding allowed).
EXPECTED = {
    "mp4-h264-aac-1080p": {"androidtv": ("direct", "native"), "appletv": ("direct", "native"), "chrome": ("direct", "web"), "safari": ("direct", "web")},
    "mp4-h264-aac-720p": {"androidtv": ("direct", "native"), "appletv": ("direct", "native"), "chrome": ("direct", "web"), "safari": ("direct", "web")},
    "mkv-h264-eac3-srt-1080p": {"androidtv": ("direct", "native"), "appletv": ("remux", "native"), "chrome": ("remux", "web"), "safari": ("remux", "web")},
    "mkv-hevc-hdr10-dts-1080p": {"androidtv": ("direct", "native"), "appletv": ("remux", "native"), "chrome": ("remux", "web"), "safari": ("remux", "web")},
    "mkv-hevc-hdr10-truehd-1080p": {"androidtv": ("remux", "native"), "appletv": ("remux", "native"), "chrome": ("remux", "web"), "safari": ("remux", "web")},
    "mkv-hevc-hdr10-truehd-2160p": {"androidtv": ("remux", "native"), "appletv": ("remux", "native"), "chrome": ("remux", "web"), "safari": ("remux", "web")},
    "mkv-av1-opus-1080p": {"androidtv": ("direct", "native"), "appletv": ("direct", "vlc"), "chrome": ("remux", "web"), "safari": ("transcode", "web")},
    "mkv-dualaudio-ass-1080p": {"androidtv": ("direct", "native"), "appletv": ("remux", "native"), "chrome": ("remux", "web"), "safari": ("remux", "web")},
    "mpg-mpeg2-ac3-576p": {"androidtv": ("direct", "vlc"), "appletv": ("direct", "vlc"), "chrome": ("transcode", "web"), "safari": ("transcode", "web")},
    "mpg-mpeg2-ac3-480p": {"androidtv": ("direct", "vlc"), "appletv": ("direct", "vlc"), "chrome": ("transcode", "web"), "safari": ("transcode", "web")},
}


def start(token, work_id, device, release_id=None, preferences=None, **extra):
    body = {"workId": work_id, "device": device, "preferences": preferences or {}}
    if release_id:
        body["releaseId"] = release_id
    body.update(extra)
    return http("POST", "/api/v1/viewer/playback", body, token)


def wait(token, playback_id, timeout=120):
    seen = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, body = http("GET", f"/api/v1/viewer/playback/{playback_id}", token=token)
        if status != 200:
            return status, body, seen
        if not seen or seen[-1] != body["state"]:
            seen.append(body["state"])
        if body["state"] in ("ready", "failed"):
            return status, body, seen
        time.sleep(max(0.1, body.get("pollAfterMs", 500) / 1000 / 2))
    return 0, None, seen


def stop(token, playback_id):
    return http("POST", f"/api/v1/viewer/playback/{playback_id}/stop", {}, token)[0]


def ffprobe(url):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", BASE + url],
                         capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        return None, out.stderr.strip()[-300:]
    return [(s["codec_type"], s["codec_name"]) for s in json.loads(out.stdout)["streams"]], None


RANGE_TRANSFER = {"PQ": "smpte2084", "HLG": "arib-std-b67"}


def fetch_bytes(url):
    with urllib.request.urlopen(BASE + url if url.startswith("/") else url, timeout=180) as resp:
        return resp.read()


def resolve(base_url, ref):
    return urllib.parse.urljoin(BASE + base_url, ref)


def colour_tags(url):
    """VIDEO-RANGE of the master and the video colour tags of its init + first segment (ffprobe)."""
    master = fetch_bytes(url).decode()
    lines = master.splitlines()
    index = next(i for i, line in enumerate(lines) if line.startswith("#EXT-X-STREAM-INF:"))
    attrs = lines[index]
    video_range = attrs.split("VIDEO-RANGE=")[1].split(",")[0] if "VIDEO-RANGE=" in attrs else "SDR"
    media = resolve(url, lines[index + 1].strip())
    playlist = fetch_bytes(media).decode()
    init = next(line.split('URI="')[1].split('"')[0] for line in playlist.splitlines() if line.startswith("#EXT-X-MAP:"))
    first = next(line.strip() for line in playlist.splitlines() if line.strip() and not line.startswith("#"))
    data = fetch_bytes(urllib.parse.urljoin(media, init)) + fetch_bytes(urllib.parse.urljoin(media, first))
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-print_format", "json", "-show_streams",
                          "-show_frames", "-read_intervals", "%+#1", "-"], input=data, capture_output=True, timeout=180)
    probe = json.loads(out.stdout or b"{}")
    stream = (probe.get("streams") or [{}])[0]
    tags = {k: stream.get(k) for k in ("color_transfer", "color_primaries", "color_space", "color_range")}
    side = [d.get("side_data_type") for f in probe.get("frames", [])[:1] for d in f.get("side_data_list", [])]
    return video_range, tags, side


def colour_check(label, body):
    """Fails when VIDEO-RANGE and the stream colour tags disagree (SDR: no PQ/HLG/BT.2020; HDR-sourced transcodes: BT.709, no HDR10 metadata)."""
    if body["method"] == "direct":
        return
    try:
        video_range, tags, side = colour_tags(body["url"])
    except Exception as err:  # noqa: BLE001
        check(f"{label}: VIDEO-RANGE matches the colour tags of init + segment 0", False, repr(err)[:200])
        return
    transfer = tags["color_transfer"] or "unknown"
    if video_range in RANGE_TRANSFER:
        ok = transfer == RANGE_TRANSFER[video_range]
    else:
        ok = transfer not in RANGE_TRANSFER.values() and tags["color_primaries"] != "bt2020"
        source_hdr = ((body.get("mediaInfo") or {}).get("video") or {}).get("hdr") or "none"
        if body["method"] == "transcode" and source_hdr != "none":
            ok = ok and all(tags[k] == "bt709" for k in ("color_transfer", "color_primaries", "color_space")) \
                and tags["color_range"] in (None, "tv") and "Mastering display metadata" not in side \
                and "Content light level metadata" not in side
    check(f"{label}: VIDEO-RANGE matches the colour tags of init + segment 0", ok, f"{video_range} {tags} {side}")


def hlssim(url, duration=18, decode=False, seek=None):
    if not HLSSIM:
        return True, "hlssim not given"
    cmd = ["dotnet", HLSSIM, "--server", BASE, "--playlist", url, "--rate", "0", "--duration", str(duration), "--quiet"]
    if decode:
        cmd.append("--decode")
    if seek:
        cmd += ["--seek", seek]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    text = out.stdout + out.stderr
    summary = next((line for line in text.splitlines() if line.startswith("playlist ")), "")
    return out.returncode == 0 and "PASS" in text, summary or text.strip()[-300:]


def play_url(label, body, expect_video=None):
    url = body["url"]
    streams, error = ffprobe(url)
    ok = streams is not None and (expect_video is None or ("video", expect_video) in streams)
    check(f"{label}: ffprobe reads the {body['method']} URL", ok, error or str(streams))
    if body["method"] != "direct":
        passed, summary = hlssim(url, decode=body["method"] == "remux")
        check(f"{label}: hlssim plays the HLS URL without credentials", passed, summary)
        colour_check(label, body)


def variant_releases(manifest):
    picks = {}
    for title in manifest["titles"]:
        if title["type"] != "movie":
            continue
        for r in title["releases"]:
            if r.get("health") == "dead" or r["variant"] in picks:
                continue
            picks[r["variant"]] = (title, r)
    return picks


def media_matrix(manifest, anna):
    picks = variant_releases(manifest)
    for variant, per_device in EXPECTED.items():
        title, release = picks[variant]
        video_codec = next(s["codec"] for s in release["files"][0]["streams"] if s["type"] == "video")
        for device_name, (method, engine) in per_device.items():
            if QUICK and device_name in ("safari",):
                continue
            label = f"{variant} on {device_name}"
            status, created = start(anna, title["workId"], DEVICES[device_name], release["releaseId"], {"audioLanguage": "en"})
            if not check(f"{label}: POST 202", status == 202, str(created)[:200]):
                continue
            status, body, seen = wait(anna, created["playbackId"])
            ok = body is not None and body["state"] == "ready" and (body["method"], body["engine"]) == (method, engine)
            detail = f"{body and body['state']} {body and body.get('method')}/{body and body.get('engine')} states={seen}"
            if body and body["state"] == "failed":
                detail += f" error={body['error']}"
            check(f"{label}: ready as {method}/{engine}", ok, detail)
            if ok:
                check(f"{label}: decision reasons carry stable codes", all(r["code"] for r in body["decision"]["reasons"]),
                      ",".join(r["code"] for r in body["decision"]["reasons"]))
                check(f"{label}: mediaInfo lists audio + subtitle tracks", len(body["mediaInfo"]["audioTracks"]) >= 1,
                      f"audio={len(body['mediaInfo']['audioTracks'])} subs={len(body['mediaInfo']['subtitleTracks'])}")
                video = body["mediaInfo"]["video"] or {}
                want_range = "SDR" if method == "transcode" or video.get("hdr") in (None, "none") else {"hdr10": "PQ", "hlg": "HLG"}.get(video["hdr"])
                check(f"{label}: videoRange agrees with hdr and the method", video.get("videoRange") == want_range,
                      f"hdr={video.get('hdr')} videoRange={video.get('videoRange')} method={method}")
                play_url(label, body, None if method == "transcode" else video_codec)
            check(f"{label}: stop 204", stop(anna, created["playbackId"]) == 204)


def dead_fallback(manifest, anna):
    for scenario in manifest["scenarios"]["deadFallback"]:
        label = f"dead release {scenario['deadName']}"
        status, created = start(anna, scenario["workId"], APPLE_TV, scenario["deadReleaseId"])
        check(f"{label}: POST 202", status == 202, str(created)[:200])
        status, body, seen = wait(anna, created["playbackId"])
        statuses = [a["status"] for a in body["attempts"]] if body else []
        check(f"{label}: attempts show the dead release then the fallback", body and body["state"] == "ready" and statuses == ["dead", "ready"]
              and body["attempts"][1]["releaseId"] == scenario["expectedFallbackReleaseId"], f"{statuses} states={seen}")
        check(f"{label}: fallbackFrom names the requested release", body and body["fallbackFrom"] and body["fallbackFrom"]["releaseId"] == scenario["deadReleaseId"],
              str(body and body["fallbackFrom"]))
        check(f"{label}: version is the fallback release", body and body["version"]["releaseId"] == scenario["expectedFallbackReleaseId"])
        check(f"{label}: reasons include fallback_used", body and any(r["code"] == "fallback_used" for r in body["decision"]["reasons"]))
        if body and body["state"] == "ready":
            play_url(label, body)
        stop(anna, created["playbackId"])


def gast_checks(manifest, picks):
    gast_tv = login("gast", "Gast TV")
    gast_phone = login("gast", "Gast Phone")
    title, remux_release = picks["mkv-hevc-hdr10-truehd-2160p"]
    status, created = start(gast_tv, title["workId"], CHROME, remux_release["releaseId"])
    status, body, _ = wait(gast_tv, created["playbackId"])
    check("gast: HEVC 2160p TrueHD on Chrome is a remux (allowed without transcoding)", body and body["state"] == "ready" and body["method"] == "remux",
          f"{body and body['state']} {body and body.get('method')}")
    if body and body["state"] == "ready":
        play_url("gast remux", body)
    first = created["playbackId"]
    status, other = start(gast_phone, title["workId"], CHROME, remux_release["releaseId"])
    check("gast: a second device gets 409 too_many_streams naming the first device",
          status == 409 and other["error"]["code"] == "too_many_streams" and other["error"]["params"].get("device") == "Gast TV", f"{status} {other}")
    legacy_title, legacy = picks["mpg-mpeg2-ac3-576p"]
    status, created = start(gast_tv, legacy_title["workId"], CHROME, legacy["releaseId"])
    check("gast: the same device may replace its own playback", status == 202, str(created)[:160])
    status, _ = http("GET", f"/api/v1/viewer/playback/{first}", token=gast_tv)
    check("gast: the replaced playback is gone (404)", status == 404, str(status))
    status, body, _ = wait(gast_tv, created["playbackId"])
    check("gast: MPEG-2 on Chrome needs a transcode → failed transcoding_not_allowed",
          body and body["state"] == "failed" and body["error"]["code"] == "transcoding_not_allowed" and "otherVersion" in body["suggestedActions"],
          f"{body and body.get('error')} {body and body.get('suggestedActions')}")
    check("gast: the failed decision lists why each method was skipped",
          body and any(s["method"] == "transcode" and any(r["code"] == "transcoding_not_allowed" for r in s["reasons"]) for s in body["decision"]["skipped"]))
    status, other = start(gast_phone, title["workId"], CHROME, remux_release["releaseId"])
    check("gast: a failed playback frees the slot for another device", status == 202, f"{status} {str(other)[:160]}")
    if status == 202:
        wait(gast_phone, other["playbackId"])
        stop(gast_phone, other["playbackId"])
    stop(gast_tv, created["playbackId"])


def kind_checks(manifest, picks):
    kind = login("kind", "Kind Tablet")
    by_title = {t["title"]: t for t in manifest["titles"]}
    for name, reason in (("Night of the Living Dead", "above_age_limit"), ("Tears of Steel", "unrated_blocked")):
        status, body = start(kind, by_title[name]["workId"], SAFARI)
        check(f"kind: {name} → 403 age_restricted ({reason})",
              status == 403 and body["error"]["code"] == "age_restricted" and body["error"]["params"]["reason"] == reason, f"{status} {body}")
    status, body = start(kind, by_title["Big Buck Bunny"]["workId"], SAFARI)
    check("kind: Big Buck Bunny (6) is allowed", status == 202, str(status))
    if status == 202:
        _, ready, _ = wait(kind, body["playbackId"])
        check("kind: Big Buck Bunny becomes ready", ready and ready["state"] == "ready", str(ready and ready["state"]))
        stop(kind, body["playbackId"])


def rendition_codec_checks(picks, anna):
    """B8: the same device and title deliver the same rendition group at start (either language) and after /switch."""
    title, release = picks["mkv-dualaudio-ass-1080p"]
    layouts = {1: "1.0", 2: "2.0", 6: "5.1", 8: "7.1"}
    for device_name, device in (("safari", SAFARI), ("iphone", IPHONE_SIM), ("appletv", APPLE_TV)):
        groups = []
        for language in ("de", "en"):
            status, created = start(anna, title["workId"], device, release["releaseId"], {"audioLanguage": language})
            _, body, _ = wait(anna, created["playbackId"])
            if not check(f"rendition codec: {device_name} {language} ready with renditions", body and body["state"] == "ready" and body.get("audioRenditions"),
                         str(body and body.get("state"))):
                continue
            groups.append(sorted((r["streamIndex"], r["codec"], r["channels"], r["label"]) for r in body["audioRenditions"]))
            check(f"rendition codec: {device_name} {language} labels name the delivered channels",
                  all(r["label"].endswith(layouts.get(r["channels"], "?")) for r in body["audioRenditions"]), json.dumps(body["audioRenditions"]))
            other = next(a for a in body["mediaInfo"]["audioTracks"] if not a["selected"])
            status, _ = http("POST", f"/api/v1/viewer/playback/{created['playbackId']}/switch", {"audioStreamIndex": other["index"]}, anna)
            _, body, _ = wait(anna, created["playbackId"])
            for _ in range(20):
                if not body or body.get("revision", 0) >= 1:
                    break
                time.sleep(0.25)
                _, body, _ = wait(anna, created["playbackId"])
            if body and body["state"] == "ready" and body.get("revision") == 1:
                groups.append(sorted((r["streamIndex"], r["codec"], r["channels"], r["label"]) for r in body.get("audioRenditions") or []))
            stop(anna, created["playbackId"])
        check(f"rendition codec: {device_name} delivers one group at start (de, en) and after /switch", len(groups) == 4 and all(g == groups[0] for g in groups),
              json.dumps(groups))


def switch_checks(manifest, picks, anna):
    title, release = picks["mkv-dualaudio-ass-1080p"]
    status, created = start(anna, title["workId"], APPLE_TV, release["releaseId"], {"audioLanguage": "de", "subtitleMode": "forced"})
    _, body, _ = wait(anna, created["playbackId"])
    audio = body["mediaInfo"]["audioTracks"]
    subs = body["mediaInfo"]["subtitleTracks"]
    german = next(a for a in audio if a["language"] == "de")
    english = next(a for a in audio if a["language"] == "en")
    forced = next((s for s in subs if s["forced"]), None)
    check("switch: German audio chosen from the language preference", german["selected"] and not english["selected"], json.dumps(audio))
    check("switch: forced German subtitle chosen for subtitleMode forced", forced and forced["selected"] and forced["language"] == "de", json.dumps(subs))
    first_url = body["url"]
    if HLSSIM:
        hlssim(first_url, duration=12)
    ass = next(s for s in subs if s["codec"] == "ass" and s["language"] == "en")
    status, switched = http("POST", f"/api/v1/viewer/playback/{created['playbackId']}/switch",
                            {"positionTicks": 60 * 10_000_000, "audioStreamIndex": english["index"], "subtitleStreamIndex": ass["index"]}, anna)
    check("switch: 202 with a new revision", status == 202 and switched["revision"] == 1 and switched["state"] in ("planning", "starting", "ready"),
          f"{status} {switched and switched.get('state')}")
    _, body, seen = wait(anna, created["playbackId"])
    audio = body["mediaInfo"]["audioTracks"]
    subs = body["mediaInfo"]["subtitleTracks"]
    check("switch: ready again with English audio and the English ASS subtitle as WebVTT",
          body["state"] == "ready" and next(a for a in audio if a["index"] == english["index"])["selected"]
          and next(s for s in subs if s["index"] == ass["index"])["selected"]
          and next(s for s in subs if s["index"] == ass["index"])["deliveredAs"] == "webvtt", f"states={seen}")
    check("switch: new URL, starting at 60 s", body["url"] != first_url and body["startPositionTicks"] == 600_000_000, body["url"])
    status, _ = http("GET", first_url)
    check("switch: the previous URL keeps working during the grace period", status == 200, str(status))
    if HLSSIM:
        passed, summary = hlssim(body["url"], duration=12, decode=True)
        check("switch: hlssim plays the switched rendition", passed, summary)
    return created["playbackId"], body, first_url


def playlist_durations(url):
    status, text = http("GET", url)
    text = text.decode() if isinstance(text, bytes) else str(text)
    return [line[8:].rstrip(",") for line in text.splitlines() if line.startswith("#EXTINF:")]


def rendition_checks(manifest, picks, anna):
    """B5: remux and transcode masters carry one EXT-X-MEDIA TYPE=AUDIO rendition per offered track."""
    title, release = picks["mkv-dualaudio-ass-1080p"]
    for device, prefs, method, codec in (("appletv", {"audioLanguage": "en"}, "remux", "ac3"),
                                         ("chrome", {"audioLanguage": "en"}, "remux", "aac"),
                                         ("chrome", {"audioLanguage": "de", "maxHeight": 720}, "transcode", "aac")):
        label = f"renditions: dual audio {method} on {device}"
        status, created = start(anna, title["workId"], DEVICES[device], release["releaseId"], prefs)
        _, body, _ = wait(anna, created["playbackId"])
        if not check(f"{label}: ready as {method}", body and body["state"] == "ready" and body["method"] == method, str(body and body.get("method"))):
            continue
        renditions = body.get("audioRenditions") or []
        selected = next(a for a in body["mediaInfo"]["audioTracks"] if a["selected"])
        check(f"{label}: inSessionAudioSwitch with two renditions, the selected track is the default",
              body.get("inSessionAudioSwitch") is True and len(renditions) == 2
              and [r["streamIndex"] for r in renditions if r["default"]] == [selected["index"]]
              and {r["language"] for r in renditions} == {"de", "en"} and all(r["codec"] == codec for r in renditions),
              json.dumps(renditions))
        check(f"{label}: audio tracks name their rendition", all(a.get("renditionId") for a in body["mediaInfo"]["audioTracks"]),
              json.dumps([(a["index"], a.get("renditionId")) for a in body["mediaInfo"]["audioTracks"]]))
        _, master = http("GET", body["url"])
        master = master.decode() if isinstance(master, bytes) else str(master)
        audio_lines = [line for line in master.splitlines() if line.startswith("#EXT-X-MEDIA:TYPE=AUDIO")]
        variant = next((line for line in master.splitlines() if line.startswith("#EXT-X-STREAM-INF:")), "")
        check(f"{label}: master has one AUDIO rendition per track in group 'audio' and the variant references it",
              len(audio_lines) == 2 and all('GROUP-ID="audio"' in line and "LANGUAGE=" in line and "CHANNELS=" in line
                                            and "AUTOSELECT=YES" in line for line in audio_lines)
              and sum("DEFAULT=YES" in line for line in audio_lines) == 1 and 'AUDIO="audio"' in variant, variant)
        base = body["url"].rsplit("/", 1)[0]
        streams, error = ffprobe(f"{base}/main.m3u8")
        check(f"{label}: the video playlist carries no audio", streams is not None and all(t == "video" for t, _ in streams), error or str(streams))
        main_durations = playlist_durations(f"{base}/main.m3u8")
        for rendition in renditions:
            url = f"{base}/audio/{rendition['id']}/main.m3u8"
            streams, error = ffprobe(url)
            check(f"{label}: ffprobe reads rendition {rendition['id']} as one {codec} audio stream",
                  streams == [("audio", codec)], error or str(streams))
            check(f"{label}: rendition {rendition['id']} segments are aligned with the video playlist",
                  playlist_durations(url) == main_durations and len(main_durations) > 0, f"{len(main_durations)} segments")
        if HLSSIM:
            passed, summary = hlssim(body["url"], duration=30, decode=True, seek="10:120")
            check(f"{label}: hlssim plays video + both audio renditions with a seek", passed, summary)
        check(f"{label}: stop 204", stop(anna, created["playbackId"]) == 204)

    title, single = picks["mkv-h264-eac3-srt-1080p"]
    status, created = start(anna, title["workId"], CHROME, single["releaseId"], {"audioLanguage": "en"})
    _, body, _ = wait(anna, created["playbackId"])
    _, master = http("GET", body["url"]) if body and body.get("url") else (0, "")
    master = master.decode() if isinstance(master, bytes) else str(master)
    check("renditions: a single-audio remux keeps its muxed audio", body and body.get("inSessionAudioSwitch") is False
          and body.get("audioRenditions") == [] and "TYPE=AUDIO" not in master, str(body and body.get("audioRenditions")))
    stop(anna, created["playbackId"])
    title, release = picks["mkv-dualaudio-ass-1080p"]
    status, created = start(anna, title["workId"], ANDROID_TV, release["releaseId"], {"audioLanguage": "en"})
    _, body, _ = wait(anna, created["playbackId"])
    check("renditions: direct play switches in the engine (no renditions)", body and body.get("method") == "direct"
          and body.get("inSessionAudioSwitch") is False and body.get("audioRenditions") == [], str(body and body.get("method")))
    stop(anna, created["playbackId"])


def heartbeat_checks(manifest, picks, anna, playback_id, body, first_url):
    status, state = http("POST", "/api/v1/viewer/watch/progress",
                         {"event": "progress", "workId": body["workId"], "positionTicks": 900_000_000, "durationTicks": 1_800_000_000,
                          "playbackId": playback_id}, anna)
    check("heartbeat: watch progress with playbackId fills the release", status == 200 and state["lastReleaseId"] == body["version"]["releaseId"],
          f"{status} {state and state.get('lastReleaseId')}")
    admin_status, admin = http("POST", "/api/v1/auth/login", {"username": "admin", "password": "streamarr-dev"})
    status, events = http("GET", "/api/v1/events?limit=20", token=admin["token"])
    match = [e for e in events if e.get("playbackSessionId") == playback_id]
    check("heartbeat: the shared event stream got source streamarr-viewer with the stream token",
          match and match[0]["source"] == "streamarr-viewer" and match[0]["sessionToken"] == body["streamToken"], str(match[:1]))
    other_viewer = login("gast", "Gast Laptop")
    status, _ = http("GET", f"/api/v1/viewer/playback/{playback_id}", token=other_viewer)
    check("ownership: another viewer gets 404", status == 404, str(status))
    anna_phone = login("anna", "Anna Phone")
    status, _ = http("GET", f"/api/v1/viewer/playback/{playback_id}", token=anna_phone)
    check("ownership: the same viewer on another device gets 404", status == 404, str(status))
    status, _ = http("POST", f"/api/v1/viewer/playback/{playback_id}/stop", {}, anna_phone)
    check("ownership: another device cannot stop it (404)", status == 404, str(status))
    check("stop: 204", stop(anna, playback_id) == 204)
    status, _ = http("GET", f"/api/v1/viewer/playback/{playback_id}", token=anna)
    check("stop: the playback is gone (404)", status == 404, str(status))
    status, _ = http("GET", body["url"])
    check("stop: its HLS session is closed (404)", status == 404, str(status))
    status, _ = http("GET", first_url)
    check("stop: the switched-away HLS session is closed too (404)", status == 404, str(status))


def tone_map_checks(manifest, picks, anna):
    for variant in ("mkv-hevc-hdr10-truehd-2160p", "mkv-hevc-hdr10-truehd-1080p", "mkv-hevc-hdr10-dts-1080p"):
        title, release = picks[variant]
        label = f"{variant} on iphone-sim"
        status, created = start(anna, title["workId"], IPHONE_SIM, release["releaseId"], {"audioLanguage": "en"})
        if not check(f"{label}: POST 202", status == 202, str(created)[:200]):
            continue
        _, body, _ = wait(anna, created["playbackId"])
        if check(f"{label}: HDR10 tone-mapped to an SDR H.264 transcode", body is not None and body["state"] == "ready"
                 and body["method"] == "transcode", f"{body and body.get('state')} {body and body.get('method')}"):
            colour_check(label, body)
        stop(anna, created["playbackId"])


def preference_checks(manifest, picks, anna):
    title, release = picks["mp4-h264-aac-1080p"]
    status, created = start(anna, title["workId"], ANDROID_TV, release["releaseId"], {"engine": "vlc"})
    _, body, _ = wait(anna, created["playbackId"])
    check("preferences: engine vlc plays an MP4 with VLC", body["state"] == "ready" and (body["method"], body["engine"]) == ("direct", "vlc"),
          f"{body.get('method')}/{body.get('engine')}")
    stop(anna, created["playbackId"])
    title, release = picks["mkv-av1-opus-1080p"]
    status, created = start(anna, title["workId"], APPLE_TV, release["releaseId"], {"engine": "native"})
    _, body, _ = wait(anna, created["playbackId"])
    check("preferences: engine native on Apple TV transcodes AV1 instead of VLC",
          body["state"] == "ready" and (body["method"], body["engine"]) == ("transcode", "native"), f"{body.get('method')}/{body.get('engine')}")
    stop(anna, created["playbackId"])
    title, release = picks["mkv-hevc-hdr10-truehd-2160p"]
    status, created = start(anna, title["workId"], APPLE_TV, release["releaseId"], {"maxHeight": 720})
    _, body, _ = wait(anna, created["playbackId"])
    check("preferences: maxHeight 720 on the 2160p HEVC release transcodes to 720p",
          body["state"] == "ready" and body["method"] == "transcode" and body["mediaInfo"]["video"]["deliveredHeight"] == 720,
          f"{body.get('method')} {body.get('mediaInfo', {}).get('video')}")
    if body["state"] == "ready":
        passed, summary = hlssim(body["url"], duration=12)
        check("preferences: hlssim plays the 720p transcode", passed, summary)
        colour_check("preferences: 720p transcode of HDR10", body)
        status, stepped = http("POST", f"/api/v1/viewer/playback/{created['playbackId']}/switch", {"stepDown": True, "preferences": {"maxHeight": 2160}}, anna)
        _, body, _ = wait(anna, created["playbackId"])
        check("switch: stepDown excludes the transcode that failed on the device; with maxHeight 2160 the remux follows",
              body["state"] == "ready" and body["method"] == "remux", f"{body.get('method')}")
    stop(anna, created["playbackId"])


def recommended_checks(manifest, anna):
    sherlock = next(t for t in manifest["titles"] if t["title"] == "Sherlock")
    episode = sherlock["seasons"][0]["episodes"][0]
    _, listed = http("GET", f"/api/v1/viewer/catalog/works/{episode['workId']}/versions?{CHROME_HINTS}", token=anna)
    picked = next((v for v in listed["versions"] if v["recommended"]), None)
    status, created = start(anna, episode["workId"], CHROME, None, {"audioLanguage": "en"})
    _, body, seen = wait(anna, created["playbackId"])
    check("recommended: an episode without releaseId plays the version recommended for the device",
          body["state"] == "ready" and picked is not None and body["version"]["releaseId"] == picked["releaseId"],
          f"{body['state']} {body.get('version', {}) and body['version'].get('name')} vs {picked and picked['name']} states={seen}")
    stop(anna, created["playbackId"])
    for title in (t for t in manifest["titles"] if t["type"] == "movie"):
        _, listed = http("GET", f"/api/v1/viewer/catalog/works/{title['workId']}/versions?{CHROME_HINTS}", token=anna)
        versions = listed.get("versions", []) if isinstance(listed, dict) else []
        if any(v["predictedMethod"] in ("direct", "remux") for v in versions):
            first = versions[0]
            check(f"recommended: {title['title']} on Chrome recommends a version without transcode",
                  first["recommended"] and first["predictedMethod"] in ("direct", "remux") and first["rank"] == 1
                  and sorted(v["qualityRank"] for v in versions) == list(range(1, len(versions) + 1)),
                  f"{first['name']} {first['predictedMethod']} q{first['qualityRank']}")
    status, body = start(anna, "tmdb-tv-19885-s03e01", CHROME)
    _, body, _ = wait(anna, body["playbackId"])
    check("recommended: an episode without versions fails with no_versions", body["state"] == "failed" and body["error"]["code"] == "no_versions",
          str(body.get("error")))


def main():
    status, manifest = http("GET", "/devworld.json")
    if not check("manifest", status == 200):
        sys.exit(1)
    anna = login("anna", "Anna TV")
    picks = variant_releases(manifest)
    status, body = start(anna, "tmdb-movie-10378", {"platform": "tv", "engines": []})
    check("validation: a bad device profile is 400 invalid_device_profile", status == 400 and body["error"]["code"] == "invalid_device_profile", str(body))
    status, body = http("POST", "/api/v1/viewer/playback", {"workId": "tmdb-movie-10378", "device": ANDROID_TV}, None)
    check("auth: anonymous POST is 401", status == 401, str(status))
    media_matrix(manifest, anna)
    dead_fallback(manifest, anna)
    gast_checks(manifest, picks)
    kind_checks(manifest, picks)
    rendition_checks(manifest, picks, anna)
    rendition_codec_checks(picks, anna)
    playback_id, body, first_url = switch_checks(manifest, picks, anna)
    heartbeat_checks(manifest, picks, anna, playback_id, body, first_url)
    tone_map_checks(manifest, picks, anna)
    preference_checks(manifest, picks, anna)
    recommended_checks(manifest, anna)
    passed = sum(1 for r in results if r["ok"])
    print(f"{'OK' if not failures else 'FAILED'}: {passed} passed, {len(failures)} failed", flush=True)
    if JSON_OUT:
        with open(JSON_OUT, "w") as handle:
            json.dump({"base": BASE, "passed": passed, "failed": failures, "results": results}, handle, indent=1)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
