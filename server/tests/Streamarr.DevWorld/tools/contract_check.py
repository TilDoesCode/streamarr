#!/usr/bin/env python3
"""Checks real viewer API responses of a running Dev World against its OpenAPI contract.
Usage: contract_check.py [base_url] [--frozen server/openapi/v1.json]
Default base_url http://127.0.0.1:39310. Every response's status must be declared for its path and method and its JSON
body must match the declared schema. Covers the M1.5 changes: long-poll, switch validation, model-state errors, WebVTT in
transcodes, the 1080p transcode default, HDR tone mapping on VLC, version refresh coalescing, HLS routes after stop,
browse/genres (B1) and failed playbacks of unknown titles.
Exits non-zero when any check fails.
"""
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
FROZEN = None
if "--frozen" in sys.argv:
    i = sys.argv.index("--frozen")
    FROZEN = sys.argv[i + 1]
    del sys.argv[i:i + 2]
import e2e_playback as e2e  # noqa: E402  (reads the base URL from sys.argv)

check, http, BASE = e2e.check, e2e.http, e2e.BASE
SPEC = json.load(urllib.request.urlopen(BASE + "/openapi/v1.json"))
TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "integer": int, "number": (int, float)}


def resolve(schema):
    while "$ref" in schema:
        schema = SPEC["components"]["schemas"][schema["$ref"].split("/")[-1]]
    return schema


def mismatches(schema, value, where="$"):
    schema = resolve(schema)
    if value is None:
        return [] if schema.get("nullable") or "null" in (schema.get("type") or []) or not schema else [f"{where}: null"]
    for key in ("allOf",):
        if key in schema:
            return [m for part in schema[key] for m in mismatches(part, value, where)]
    for key in ("oneOf", "anyOf"):
        if key in schema:
            return [] if any(not mismatches(part, value, where) for part in schema[key]) else [f"{where}: no {key} branch"]
    kind = schema.get("type")
    kinds = [kind] if isinstance(kind, str) else [k for k in (kind or []) if k != "null"]
    if kinds and not any(isinstance(value, TYPES[k]) and not (k in ("integer", "number") and isinstance(value, bool)) for k in kinds):
        return [f"{where}: {type(value).__name__} is not {kinds}"]
    if "enum" in schema and value not in schema["enum"]:
        return [f"{where}: {value!r} not in enum"]
    found = []
    if isinstance(value, dict):
        props = schema.get("properties", {})
        found += [f"{where}.{name}: missing" for name in schema.get("required", []) if name not in value]
        extra = schema.get("additionalProperties", True)
        for name, item in value.items():
            if name in props:
                found += mismatches(props[name], item, f"{where}.{name}")
            elif extra is False:
                found.append(f"{where}.{name}: not declared")
            elif isinstance(extra, dict):
                found += mismatches(extra, item, f"{where}.{name}")
    if isinstance(value, list) and "items" in schema:
        for n, item in enumerate(value):
            found += mismatches(schema["items"], item, f"{where}[{n}]")
    return found


def conforms(label, template, method, status, body, raw_type=None):
    """Status declared for template/method and the JSON body matches the declared schema."""
    responses = SPEC["paths"][template][method]["responses"]
    declared = str(status) in responses
    problems = [] if declared else [f"status {status} not declared ({','.join(responses)})"]
    content = responses.get(str(status), {}).get("content", {})
    schema = (content.get("application/json") or {}).get("schema")
    if declared and schema and not raw_type:
        problems += mismatches(schema, body)
    if raw_type and declared and schema is None and content and raw_type not in content:
        problems.append(f"content type {raw_type} not declared")
    return check(f"contract: {label} -> {status}", not problems, "; ".join(problems[:5]))


def get_raw(path):
    try:
        with urllib.request.urlopen(BASE + path, timeout=120) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read().decode(errors="replace")
    except urllib.error.HTTPError as err:
        return err.code, err.headers.get("Content-Type", ""), err.read().decode(errors="replace")


def ready(anna, created, label):
    started = time.monotonic()
    body = None
    while time.monotonic() - started < 120:
        status, body = http("GET", f"/api/v1/viewer/playback/{created['playbackId']}?waitMs=10000", token=anna)
        conforms(f"{label} long-poll", "/api/v1/viewer/playback/{playbackId}", "get", status, body)
        if status != 200 or body["state"] in ("ready", "failed"):
            break
    return body, time.monotonic() - started


def main():
    if FROZEN:
        with open(FROZEN) as handle:
            check("live /openapi/v1.json equals the frozen contract", json.load(handle) == SPEC)
    _, manifest = http("GET", "/devworld.json")
    picks = e2e.variant_releases(manifest)
    anna = e2e.login("anna", "Contract TV")

    status, body = http("GET", "/api/v1/viewer/catalog/discover")
    conforms("anonymous discover", "/api/v1/viewer/catalog/discover", "get", status, body)
    status, body = http("GET", "/api/v1/viewer/catalog/discover", token=anna)
    conforms("discover", "/api/v1/viewer/catalog/discover", "get", status, body)
    browse, genres = "/api/v1/viewer/catalog/browse", "/api/v1/viewer/catalog/genres"
    kid = e2e.login("kind", "Contract Kid")
    pages = []
    for query, token in (("type=movie", anna), ("type=movie&page=3", anna), ("type=series&sort=top_rated", anna),
                         ("type=movie&genre=27&sort=newest", anna), ("type=movie&page=2", kid)):
        status, body = http("GET", f"{browse}?{query}", token=token)
        conforms(f"browse?{query}", browse, "get", status, body)
        pages.append(body)
    check("browse pages by 4 with hasMore", [len(pages[0]["items"]), pages[0]["hasMore"], len(pages[1]["items"]), pages[1]["hasMore"]]
          == [4, True, 1, False], str([(p.get("page"), p.get("totalPages"), p.get("hasMore")) for p in pages[:2]]))
    check("browse filters by genre", {i["title"] for i in pages[3]["items"]} == {"Sprite Fright", "Night of the Living Dead"},
          str([i["title"] for i in pages[3]["items"]]))
    check("browse hides titles above the kid's age", [i["title"] for i in pages[4]["items"]] == ["Cosmos Laundromat"],
          str([i["title"] for i in pages[4]["items"]]))
    for query in ("type=movie", "type=series"):
        status, body = http("GET", f"{genres}?{query}", token=anna)
        conforms(f"genres?{query}", genres, "get", status, body)
    for path, code in ((f"{browse}?type=music", "invalid_query"), (f"{browse}?type=movie&page=501", "invalid_query"),
                       (f"{browse}?type=movie&page=x", "invalid_request"), (f"{genres}", "invalid_query")):
        status, body = http("GET", path, token=anna)
        conforms(path.split("/")[-1], path.split("?")[0], "get", status, body)
        check(f"{path.split('/')[-1]} is 400 {code}", status == 400 and body["error"]["code"] == code, str(body)[:160])
    status, body = http("GET", f"{browse}?type=movie")
    conforms("anonymous browse", browse, "get", status, body)
    status, created = e2e.start(anna, "tmdb-movie-999999", e2e.CHROME)
    missing, _ = ready(anna, created, "unknown title")
    check("title_not_found suggests no otherVersion", missing["state"] == "failed" and missing["error"]["code"] == "title_not_found"
          and "otherVersion" not in (missing.get("suggestedActions") or []), str(missing.get("error")) + str(missing.get("suggestedActions")))
    status, body = http("GET", "/api/v1/viewer/watch/resume?limit=abc", token=anna)
    conforms("resume?limit=abc", "/api/v1/viewer/watch/resume", "get", status, body)
    check("malformed query is 400 invalid_request", status == 400 and body["error"]["code"] == "invalid_request", str(body)[:160])

    title, hdr = picks["mkv-hevc-hdr10-dts-1080p"]
    versions = f"/api/v1/viewer/catalog/works/{title['workId']}/versions"
    status, body = http("GET", f"{versions}?videoCodecs=hevc&audioCodecs=aac,dts&containers=mkv&hdrFormats=hdr10", token=anna)
    conforms("versions with hdrFormats only", "/api/v1/viewer/catalog/works/{workId}/versions", "get", status, body)
    version = next((v for v in (body or {}).get("versions", []) if v["releaseId"] == hdr["releaseId"]), None)
    reasons = [r["code"] for r in version.get("predictionReasons") or []] if version else []
    check("hdrFormats implies 10-bit in predictions", version is not None and "bit_depth_unsupported" not in reasons,
          f"{version and version.get('predictedMethod')} {reasons}")
    first = http("GET", f"{versions}?refresh=true", token=anna)
    second = http("GET", f"{versions}?refresh=true", token=anna)
    check("a second refresh within a minute is served from the cache", first[0] == 200 and second[0] == 200 and second[1]["fromCache"],
          f"{first[1].get('fromCache')} -> {second[1].get('fromCache')}")

    # Chrome, dual audio + ASS at 720p: a transcode that carries the text subtitles as WebVTT.
    title, dual = picks["mkv-dualaudio-ass-1080p"]
    subs = [s for s in dual["files"][0]["streams"] if s["type"] == "subtitle"]
    status, created = e2e.start(anna, title["workId"], e2e.CHROME, dual["releaseId"],
                                {"maxHeight": 720, "audioLanguage": "en", "subtitleLanguage": "en"})
    conforms("start transcode", "/api/v1/viewer/playback", "post", status, created)
    body, took = ready(anna, created, "transcode")
    check("long-poll answers the ready state", body and body["state"] == "ready" and body["method"] == "transcode",
          f"{body and body['state']} {body and body.get('method')} after {took:.2f} s")
    webvtt = [t for t in body["mediaInfo"]["subtitleTracks"] if t["deliveredAs"] == "webvtt"] if body else []
    check("transcode delivers text subtitles as webvtt", len(webvtt) == len(subs) > 0, f"{len(webvtt)} of {len(subs)}")
    base = body["url"].rsplit("/", 1)[0] if body else ""
    status, ctype, master = get_raw(body["url"]) if body else (0, "", "")
    check("transcode master lists SUBTITLES renditions", status == 200 and "TYPE=SUBTITLES" in master, f"{status}")
    stream = webvtt[0]["index"] if webvtt else 0
    status, ctype, vtt = get_raw(f"{base}/subtitles/{stream}/1.vtt")
    conforms("transcode .vtt segment", "/api/v1/transcode/{token}/subtitles/{stream}/{segment}.vtt", "get", status, None, ctype.split(";")[0])
    check("WebVTT segment of a transcode", status == 200 and vtt.startswith("WEBVTT"), f"{status} {ctype}")
    renditions = body.get("audioRenditions") or [] if body else []
    check("dual-audio transcode lists two audio renditions and inSessionAudioSwitch",
          body and body.get("inSessionAudioSwitch") is True and len(renditions) == 2 and master.count("TYPE=AUDIO") == 2
          and 'AUDIO="audio"' in master, str(renditions)[:200])
    rendition = renditions[0]["id"] if renditions else "1"
    for route, template, kind in ((f"{base}/audio/{rendition}/main.m3u8", "/api/v1/transcode/{token}/audio/{rendition}/main.m3u8", "application/vnd.apple.mpegurl"),
                                  (f"{base}/audio/{rendition}/init.mp4", "/api/v1/transcode/{token}/audio/{rendition}/init.mp4", "video/mp4"),
                                  (f"{base}/audio/{rendition}/1.m4s", "/api/v1/transcode/{token}/audio/{rendition}/{segment}.m4s", "video/mp4")):
        status, ctype, _ = get_raw(route)
        conforms(f"audio rendition {route.rsplit('/', 1)[-1]}", template, "get", status, None, ctype.split(";")[0])
        check(f"audio rendition {route.rsplit('/', 1)[-1]} is {kind}", status == 200 and ctype.startswith(kind), f"{status} {ctype}")
    status, ctype, text = get_raw(f"{base}/audio/99/main.m3u8")
    unknown = json.loads(text) if ctype.startswith("application/json") else {}
    conforms("unknown audio rendition", "/api/v1/transcode/{token}/audio/{rendition}/main.m3u8", "get", status, unknown)
    check("unknown audio rendition is 404 unknown_audio_rendition", status == 404 and unknown.get("error", {}).get("code") == "unknown_audio_rendition", f"{status}")

    playing = body["url"] if body else None
    status, bad = http("POST", f"/api/v1/viewer/playback/{created['playbackId']}/switch", {"audioStreamIndex": 99}, anna)
    conforms("switch to a missing track", "/api/v1/viewer/playback/{playbackId}/switch", "post", status, bad)
    check("missing track is 400 unknown_audio_stream", status == 400 and bad["error"]["code"] == "unknown_audio_stream", str(bad)[:160])
    status, after = http("GET", f"/api/v1/viewer/playback/{created['playbackId']}", token=anna)
    check("the playback keeps playing after a rejected switch", status == 200 and after["state"] == "ready" and after["url"] == playing)
    for query, code in (("waitMs=20000", "invalid_playback_request"), ("waitMs=abc", "invalid_request")):
        status, bad = http("GET", f"/api/v1/viewer/playback/{created['playbackId']}?{query}", token=anna)
        conforms(f"GET ?{query}", "/api/v1/viewer/playback/{playbackId}", "get", status, bad)
        check(f"?{query} is 400 {code}", status == 400 and bad["error"]["code"] == code, str(bad)[:160])
    status, _ = http("POST", f"/api/v1/viewer/playback/{created['playbackId']}/stop", {}, anna)
    for route, template in ((f"{base}/subtitles/{stream}/2.vtt", "/api/v1/transcode/{token}/subtitles/{stream}/{segment}.vtt"),
                            (f"{base}/3.m4s", "/api/v1/transcode/{token}/{segment}.m4s"),
                            (f"{base}/audio/{rendition}/3.m4s", "/api/v1/transcode/{token}/audio/{rendition}/{segment}.m4s"),
                            (f"{base}/init.mp4", "/api/v1/transcode/{token}/init.mp4")):
        status, ctype, text = get_raw(route)
        error = json.loads(text) if ctype.startswith("application/json") else text
        conforms(f"{route.rsplit('/', 1)[-1]} after stop", template, "get", status, error)
        check(f"{route.rsplit('/', 1)[-1]} after stop is an error envelope", status in (404, 410) and "error" in error, f"{status}")

    # 2160p HDR10 on a player without HEVC: the transcode defaults to 1080p.
    title, uhd = picks["mkv-hevc-hdr10-truehd-2160p"]
    h264_only = {"platform": "web", "vlcAvailable": False, "engines": [dict(e2e.CHROME["engines"][0], videoCodecs=[{"codec": "h264"}])]}
    status, created = e2e.start(anna, title["workId"], h264_only, uhd["releaseId"], {"audioLanguage": "en"})
    body, _ = ready(anna, created, "4K transcode")
    codes = [r["code"] for r in body["decision"]["reasons"]] if body and body.get("decision") else []
    video = body["mediaInfo"]["video"] if body and body.get("mediaInfo") else {}
    master = get_raw(body["url"])[2] if body and body.get("url") else ""
    check("a 4K transcode is scaled to 1080p by default", body and body["state"] == "ready" and body["method"] == "transcode"
          and video.get("deliveredHeight") == 1080 and "x1080," in master and "transcode_height_default" in codes,
          f"{body and body.get('method')} {video.get('height')} -> {video.get('deliveredHeight')} {codes}")
    e2e.stop(anna, created["playbackId"])

    # HDR10 on an SDR TV: libVLC that declares tone mapping plays the file direct instead of an SDR transcode.
    native = dict(e2e.ANDROID_TV["engines"][0], videoCodecs=[{"codec": "h264"}, {"codec": "hevc", "maxBitDepth": 10}])
    vlc = {"engine": "vlc", "hls": True, "maxAudioChannels": 6, "containers": ["mkv", "mp4"],
           "videoCodecs": [{"codec": "h264"}, {"codec": "hevc", "maxBitDepth": 10}],
           "audioCodecs": [{"codec": c} for c in ["aac", "ac3", "eac3", "truehd", "dts"]]}
    for tone_maps, expected in ((True, ("direct", "vlc")), (False, ("transcode", "native"))):
        profile = {"platform": "androidtv", "vlcAvailable": True, "engines": [native, dict(vlc, hdrToneMapping=tone_maps)]}
        status, created = e2e.start(anna, title["workId"], profile, uhd["releaseId"], {"audioLanguage": "en"})
        body, _ = ready(anna, created, f"hdrToneMapping={tone_maps}")
        codes = [r["code"] for r in body["decision"]["reasons"]] if body and body.get("decision") else []
        got = (body.get("method"), body.get("engine")) if body else None
        check(f"HDR10 with hdrToneMapping={tone_maps} plays as {expected[0]}/{expected[1]}",
              got == expected and (("hdr_tone_mapped" in codes) == tone_maps), f"{got} {codes}")
        e2e.stop(anna, created["playbackId"])

    passed = sum(1 for r in e2e.results if r["ok"])
    print(f"{'OK' if not e2e.failures else 'FAILED'}: {passed} passed, {len(e2e.failures)} failed", flush=True)
    sys.exit(1 if e2e.failures else 0)


if __name__ == "__main__":
    main()
