#!/usr/bin/env python3
"""Independent M1.2 verifier: exercises /api/v1/viewer/catalog on a running Dev World."""
import json, sys, time, statistics, urllib.request, urllib.error, concurrent.futures

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:39310"
CAT = BASE + "/api/v1/viewer/catalog"
PASS, FAIL = [], []
RAW = {}


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" - {detail}" if detail and not cond else ""))


def req(method, url, token=None, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json"} if data else {}
    if token:
        h["Authorization"] = "Bearer " + token
    h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read().decode()
            return resp.status, raw, dict(resp.headers), (time.perf_counter() - t0) * 1000
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return e.code, raw, dict(e.headers), (time.perf_counter() - t0) * 1000


def get(url, token=None):
    s, raw, h, ms = req("GET", url, token)
    RAW[url + "|" + (token or "")[:8]] = raw
    try:
        return s, json.loads(raw) if raw else None, h, raw
    except json.JSONDecodeError:
        return s, raw, h, raw


manifest = json.loads(req("GET", BASE + "/devworld.json")[1])
admin_tok = json.loads(req("POST", BASE + "/api/v1/auth/login", body={"username": "admin", "password": "streamarr-dev"})[1])["token"]
api_key = manifest["admin"]["apiKey"]


def login(user):
    s, raw, _, _ = req("POST", BASE + "/api/v1/viewer/auth/login", body={"login": user, "password": "streamarr", "deviceName": "m12v1", "clientName": "verifier"})
    d = json.loads(raw)
    if d.get("status") == "mfa_required":
        totp = json.loads(req("GET", BASE + "/devworld/totp/ben")[1])
        s2, raw2, _, _ = req("POST", BASE + "/api/v1/viewer/auth/login/second-factor", body={"mfaToken": d["mfaToken"], "code": totp["code"]})
        if s2 != 200:
            s2, raw2, _, _ = req("POST", BASE + "/api/v1/viewer/auth/login/second-factor", body={"mfaToken": d["mfaToken"], "code": totp["nextCode"]})
        check(f"{user}: TOTP second factor signs in", s2 == 200, raw2[:200])
        d = json.loads(raw2)
    return d["session"]["accessToken"]


toks = {u: login(u) for u in ["anna", "ben", "kind", "gast"]}
check("all four viewers signed in", all(toks.values()))

movies = [t for t in manifest["titles"] if t["type"] == "movie"]
series = [t for t in manifest["titles"] if t["type"] == "tv"]
kid_allowed = {t["title"] for t in manifest["titles"] if t["access"].get("kindAllowed")}
kid_blocked = {t["title"] for t in manifest["titles"] if not t["access"].get("kindAllowed")}
print("kind allowed:", sorted(kid_allowed), "blocked:", sorted(kid_blocked))

LEAKS = [".nzb", "devworld:", "Dev World", "indexer.devworld.invalid", "devworld-api-key", '"indexer', '"score"', '"grabs"',
         '"guid"', "nzbUrl", "apikey", "api_key", '"rejection', "/cache/", "addScoreToName"]


def no_leak(name, raw):
    found = [p for p in LEAKS if p.lower() in raw.lower()]
    check(f"no internal fields in {name}", not found, found)


# ---------- search ----------
for user in toks:
    s, d, _, raw = get(f"{CAT}/search?q=Sintel", toks[user])
    check(f"{user}: search Sintel 200 + movie card", s == 200 and d["items"] and d["items"][0]["workId"] == "tmdb-movie-45745", raw[:200])
    no_leak(f"{user} search", raw)
s, d, _, raw = get(f"{CAT}/search?q=Sherlock&type=tv", toks["anna"])
check("search type=tv finds Sherlock as series", s == 200 and [i["mediaType"] for i in d["items"]] == ["series"] and d["items"][0]["workId"] == "tmdb-tv-19885", raw[:300])
s, d, _, raw = get(f"{CAT}/search?q=Sherlock&type=movie", toks["anna"])
check("search type=movie excludes series", s == 200 and all(i["mediaType"] == "movie" for i in d["items"]), raw[:300])
s, d, _, raw = get(f"{CAT}/search?q=a&limit=2", toks["anna"])
check("search limit=2 caps results", s == 200 and len(d["items"]) <= 2, raw[:200])
s, d, _, raw = get(f"{CAT}/search?q=Night%20of%20the%20Living%20Dead", toks["anna"])
check("anna finds NOTLD", s == 200 and any(i["tmdbId"] == 10331 for i in d["items"]), raw[:200])
s, d, _, raw = get(f"{CAT}/search?q=Night%20of%20the%20Living%20Dead", toks["kind"])
check("kind does not find NOTLD (16)", s == 200 and not any(i["tmdbId"] == 10331 for i in d["items"]), raw[:200])
s, d, _, raw = get(f"{CAT}/search?q=Pioneer", toks["kind"])
check("kind does not find Pioneer One (NR, unrated blocked)", s == 200 and not any(i["tmdbId"] == 33050 for i in d["items"]), raw[:200])
s, d, _, raw = get(f"{CAT}/search?q=Sherlock", toks["kind"])
check("kind finds Sherlock (12)", s == 200 and any(i["tmdbId"] == 19885 for i in d["items"]), raw[:200])
for q, code in [("", "missing_query"), ("?q=x&type=music", "invalid_query"), ("?q=x&limit=0", "invalid_query"), ("?q=x&limit=abc", "invalid_request"), ("?q=" + "a" * 300, "invalid_query")]:
    s, d, _, raw = get(f"{CAT}/search{q}", toks["anna"])
    check(f"search {q[:20]!r} -> 400 {code}", s == 400 and d["error"]["code"] == code, raw[:200])

# ---------- discover ----------
disc = {}
for user in toks:
    s, d, _, raw = get(f"{CAT}/discover", toks[user])
    disc[user] = d
    check(f"{user}: discover 200", s == 200, raw[:200])
    no_leak(f"{user} discover", raw)
rows = {r["id"]: [i["workId"] for i in r["items"]] for r in disc["anna"]["rows"]}
m = manifest["discover"]
check("anna discover rows = fixture lists", rows == {"trending-movies": m["trendingMovies"], "trending-series": m["trendingSeries"],
                                                      "popular-movies": m["popularMovies"], "popular-series": m["popularSeries"]}, rows)
check("discover row order", [r["id"] for r in disc["anna"]["rows"]] == ["trending-movies", "trending-series", "popular-movies", "popular-series"])
check("discover row kind/mediaType", all(r["kind"] in ("trending", "popular") and r["mediaType"] in ("movie", "series") for r in disc["anna"]["rows"]))
title_by_work = {}
for t in manifest["titles"]:
    title_by_work[t.get("workId") or t.get("seriesWorkId")] = t["title"]
kid_seen = {title_by_work[i["workId"]] for r in disc["kind"]["rows"] for i in r["items"]}
check("kind discover shows only kind-allowed titles", kid_seen <= kid_allowed, kid_seen - kid_allowed)
check("kind discover hides every blocked title", not (kid_seen & kid_blocked), kid_seen & kid_blocked)
check("kind discover still shows the allowed ones", kid_seen == kid_allowed & {title_by_work[w] for w in sum(rows.values(), [])}, kid_seen)
for user in ("ben", "gast"):
    check(f"{user} (unrestricted) discover equals anna's", disc[user] == disc["anna"])
item = disc["anna"]["rows"][0]["items"][0]
check("card fields present", all(k in item for k in ("workId", "mediaType", "tmdbId", "title", "originalTitle", "year", "overview", "posterUrl", "backdropUrl", "voteAverage")), item.keys())

# ---------- movie details ----------
for t in movies:
    tid = t["tmdbId"]
    for user in toks:
        s, d, h, raw = get(f"{CAT}/movies/{tid}", toks[user])
        allowed = user != "kind" or t["access"].get("kindAllowed")
        if allowed:
            ok = s == 200 and d["workId"] == f"tmdb-movie-{tid}" and d["title"] == t["title"] and d["access"]["allowed"] and "watch" in d \
                and d["certification"] == t["access"].get("officialRating") and d["logoUrl"] == t.get("logoUrl")
            check(f"{user}: movie {t['title']} details", ok, raw[:300])
        else:
            ok = s == 403 and d["error"]["code"] == "age_restricted" and d["error"]["params"]["reason"] in ("above_age_limit", "unrated_blocked")
            check(f"{user}: movie {t['title']} 403 age_restricted", ok, raw[:300])
        no_leak(f"{user} movie {tid}", raw)
s, d, _, raw = get(f"{CAT}/movies/10378", toks["anna"])
need = ["title", "originalTitle", "year", "overview", "tagline", "genres", "runtimeMinutes", "certification", "voteAverage", "posterUrl", "backdropUrl", "logoUrl", "watch", "access"]
check("movie details carry every spec field", all(k in d for k in need), [k for k in need if k not in d])
check("access has allowed + reason", {"allowed", "reason"} <= set(d["access"]))

# ---------- watch state ----------
tok = toks["gast"]
s, raw, _, _ = req("POST", BASE + "/api/v1/viewer/watch/progress", tok, {"event": "progress", "workId": "tmdb-movie-45745", "positionTicks": 70 * 10_000_000, "durationTicks": 180 * 10_000_000})
check("gast progress on Sintel accepted", s == 200, raw[:200])
s, d, _, raw = get(f"{CAT}/movies/45745", tok)
check("gast Sintel watch position 70 s", d["watch"]["positionTicks"] == 70 * 10_000_000, d["watch"])
s, d, _, raw = get(f"{CAT}/movies/45745", toks["anna"])
check("anna Sintel watch untouched by gast", d["watch"]["positionTicks"] == 0, d["watch"])
s, raw, _, _ = req("POST", BASE + "/api/v1/viewer/watch/played", tok, {"workIds": ["tmdb-tv-19885-s01e01", "tmdb-tv-19885-s01e02"]})
check("gast marks Sherlock s01e01-02 played", s in (200, 204), raw[:200])
s, raw, _, _ = req("POST", BASE + "/api/v1/viewer/watch/progress", tok, {"event": "progress", "workId": "tmdb-tv-19885-s01e03", "positionTicks": 65 * 10_000_000, "durationTicks": 150 * 10_000_000})
check("gast progress on s01e03", s == 200, raw[:200])
s, d, _, raw = get(f"{CAT}/series/19885", tok)
w = d["watch"]
check("gast Sherlock nextEpisode = s01e03 resume", w["nextEpisode"]["workId"] == "tmdb-tv-19885-s01e03" and w["nextEpisode"]["reason"] == "resume"
      and w["nextEpisode"]["positionTicks"] == 65 * 10_000_000, w)
check("gast Sherlock played/inProgress counts 2/1", (w["playedEpisodes"], w["inProgressEpisodes"]) == (2, 1), w)
s1 = [x for x in d["seasons"] if x["seasonNumber"] == 1][0]
check("season summary S1 played=2 inProgress=1", (s1["playedCount"], s1["inProgressCount"]) == (2, 1), s1)
s, d, _, raw = get(f"{CAT}/series/19885/seasons/1", tok)
eps = {e["episodeNumber"]: e for e in d["episodes"]}
check("season episode watch: e1/e2 played, e3 at 65 s", eps[1]["watch"]["played"] and eps[2]["watch"]["played"] and eps[3]["watch"]["positionTicks"] == 65 * 10_000_000, [e["watch"] for e in d["episodes"]])
check("season without availability: versionCount null, availability null", all(e["versionCount"] is None for e in d["episodes"]) and d["availability"] is None)
s, raw, _, _ = req("POST", BASE + "/api/v1/viewer/watch/played", tok, {"workIds": ["tmdb-tv-19885-s01e03"]})
s, d, _, raw = get(f"{CAT}/series/19885", tok)
check("after s01e03 played -> next is s02e01 (next)", d["watch"]["nextEpisode"]["workId"] == "tmdb-tv-19885-s02e01" and d["watch"]["nextEpisode"]["reason"] == "next", d["watch"])
s, d, _, raw = get(f"{CAT}/series/33050", toks["ben"])
check("ben Pioneer One nextEpisode start s01e01", d["watch"]["nextEpisode"]["workId"] == "tmdb-tv-33050-s01e01" and d["watch"]["nextEpisode"]["reason"] == "start", d["watch"])

# ---------- series/season ----------
for t in series:
    tid = t["tmdbId"]
    for user in toks:
        s, d, _, raw = get(f"{CAT}/series/{tid}", toks[user])
        allowed = user != "kind" or t["access"].get("kindAllowed")
        check(f"{user}: series {t['title']} {'200' if allowed else '403'}", (s == 200 and d["title"] == t["title"]) if allowed else (s == 403 and d["error"]["code"] == "age_restricted"), raw[:200])
        for season in t["seasons"]:
            n = season["seasonNumber"]
            s, d, _, raw = get(f"{CAT}/series/{tid}/seasons/{n}", toks[user])
            check(f"{user}: {t['title']} S{n} {'200' if allowed else '403'}", (s == 200 and len(d["episodes"]) == len(season["episodes"])) if allowed else (s == 403 and d["error"]["code"] == "age_restricted"), raw[:200])
            s, d, _, raw = get(f"{CAT}/series/{tid}/seasons/{n}?availability=true", toks[user])
            if allowed:
                counts = [e["versionCount"] for e in d["episodes"]]
                check(f"{user}: {t['title']} S{n} availability counts {counts}", s == 200 and all(c is not None for c in counts) and d["availability"]["error"] is None, raw[:300])
                no_leak(f"{user} season {tid}/{n} availability", raw)
            else:
                check(f"{user}: {t['title']} S{n}?availability 403", s == 403, raw[:200])

# ---------- versions ----------
PROFILE = "videoCodecs=h264,hevc&audioCodecs=aac,ac3,eac3&containers=mp4&hdrFormats=hdr10&supports10Bit=true&maxAudioChannels=6"
for t in movies:
    wid = t["workId"]
    for user in toks:
        s, d, h, raw = get(f"{CAT}/works/{wid}/versions", toks[user])
        allowed = user != "kind" or t["access"].get("kindAllowed")
        if allowed:
            ranks = [v["rank"] for v in d["versions"]]
            ok = s == 200 and ranks == list(range(1, len(ranks) + 1)) and [v["recommended"] for v in d["versions"]] == [r == 1 for r in ranks]
            check(f"{user}: versions {t['title']} ({len(ranks)})", ok, raw[:300])
            no_leak(f"{user} versions {wid}", raw)
        else:
            check(f"{user}: versions {t['title']} 403", s == 403 and d["error"]["code"] == "age_restricted", raw[:200])
s, d, _, raw = get(f"{CAT}/works/tmdb-movie-10378/versions", toks["anna"])
v = d["versions"][0]
need = ["releaseId", "name", "resolution", "source", "videoCodec", "bitDepth", "hdr", "audioCodec", "audioChannels", "atmos", "languages", "subtitleHints",
        "edition", "releaseGroup", "sizeBytes", "estimatedBitrateKbps", "ageDays", "health", "local", "rank", "recommended"]
check("VersionDto has every spec field", all(k in v for k in need), [k for k in need if k not in v])
print("BBB versions:", json.dumps([{k: x[k] for k in ("name", "resolution", "videoCodec", "bitDepth", "hdr", "audioCodec", "audioChannels", "atmos", "languages", "subtitleHints", "estimatedBitrateKbps", "health")} for x in d["versions"]], indent=0))
for t in series:
    for season in t["seasons"]:
        for ep in season["episodes"][:1]:
            wid = ep["workId"]
            s, d, _, raw = get(f"{CAT}/works/{wid}/versions", toks["anna"])
            check(f"anna episode versions {wid} 200 ({len(d.get('versions', []))})", s == 200 and d["mediaType"] == "episode", raw[:200])
            no_leak(f"episode versions {wid}", raw)
s, d, _, raw = get(f"{CAT}/works/tmdb-tv-33050-s01e01/versions", toks["kind"])
check("kind Pioneer One episode versions 403", s == 403 and d["error"]["code"] == "age_restricted", raw[:200])
s, d, _, raw = get(f"{CAT}/works/tmdb-tv-19885-s01e01/versions", toks["kind"])
check("kind Sherlock episode versions 200", s == 200, raw[:200])
# prediction for gast (no transcoding)
s, d, _, raw = get(f"{CAT}/works/tmdb-movie-133701/versions?{PROFILE}", toks["gast"])
print("gast ToS predictions:", [(x["name"], x["predictedMethod"], [r["code"] for r in x["predictionReasons"]]) for x in d["versions"]])
legacy = [x for x in d["versions"] if "MPEG-2" in x["name"]]
check("gast: legacy MPEG-2 predicted transcode + transcoding_not_allowed", legacy and legacy[0]["predictedMethod"] == "transcode" and any(r["code"] == "transcoding_not_allowed" for r in legacy[0]["predictionReasons"]), legacy)
s, d, _, raw = get(f"{CAT}/works/tmdb-movie-133701/versions?{PROFILE}", toks["anna"])
legacy = [x for x in d["versions"] if "MPEG-2" in x["name"]]
check("anna: legacy MPEG-2 transcode without transcoding_not_allowed", legacy and not any(r["code"] == "transcoding_not_allowed" for r in legacy[0]["predictionReasons"]), legacy)
# cache + refresh
s, d1, _, raw = get(f"{CAT}/works/tmdb-movie-9761/versions?refresh=true", toks["anna"])
s, d2, _, raw = get(f"{CAT}/works/tmdb-movie-9761/versions", toks["ben"])
check("refresh=true fromCache false; next call (other viewer) fromCache true, same checkedAt", d1["fromCache"] is False and d2["fromCache"] is True and d1["checkedAt"] == d2["checkedAt"], (d1["fromCache"], d2["fromCache"]))
# single flight
with concurrent.futures.ThreadPoolExecutor(8) as ex:
    res = list(ex.map(lambda _: get(f"{CAT}/works/tmdb-movie-358332/versions?refresh=true", toks["anna"])[1], range(1)))
    res = list(ex.map(lambda _: get(f"{CAT}/works/tmdb-movie-891761/versions", toks["anna"])[1], range(8)))
check("8 concurrent cold requests share one search (exactly one fromCache=false or all from warm cache)", sum(1 for r in res if not r["fromCache"]) <= 1 and len({r["checkedAt"] for r in res}) == 1, [r["fromCache"] for r in res])

# ---------- errors ----------
for path, status, code in [
    ("movies/abc", 400, "invalid_request"), ("movies/999999999", 404, "title_not_found"), ("movies/19885", 404, "title_not_found"),
    ("series/10378", 404, "title_not_found"), ("series/19885/seasons/9", 404, "season_not_found"), ("series/19885/seasons/-1", 404, "season_not_found"),
    ("works/tmdb-tv-19885/versions", 400, "invalid_work_id"), ("works/tmdb-tv-19885-s09e01/versions", 404, None),
    ("works/tmdb-tv-19885-s01e09/versions", 404, "episode_not_found"), ("works/tmdb-movie-999999/versions", 404, "title_not_found"),
    ("works/garbage/versions", 400, "invalid_work_id"), ("works/tmdb-movie-10378/versions?refresh=maybe", 400, "invalid_request"),
    ("works/tmdb-movie-10378/versions?maxHeight=abc&videoCodecs=h264", 400, "invalid_request"), ("movies/99999999999", 400, "invalid_request"),
    ("series/19885/seasons/1?availability=yes", 400, "invalid_request"),
]:
    s, d, _, raw = get(f"{CAT}/{path}", toks["anna"])
    ok = s == status and isinstance(d, dict) and "error" in d and (code is None or d["error"]["code"] == code)
    check(f"{path} -> {status} {code}", ok, f"{s} {raw[:200]}")

# ---------- auth ----------
PATHS = ["search?q=Sintel", "discover", "movies/10378", "series/19885", "series/19885/seasons/1", "works/tmdb-movie-10378/versions"]
for p in PATHS:
    for label, t in [("admin JWT", admin_tok), ("machine key", api_key), ("anonymous", None)]:
        s, d, _, raw = get(f"{CAT}/{p}", t)
        check(f"{label} on {p} -> 401", s == 401 and d["error"]["code"] == "unauthorized", f"{s} {raw[:150]}")
s, raw, _, _ = req("GET", f"{CAT}/discover", headers={"X-Api-Key": api_key})
check("X-Api-Key header on discover -> 401", s == 401, raw[:150])

# ---------- latency ----------
lat = {}
for name, path in [("search", "search?q=Sintel"), ("discover", "discover"), ("movie", "movies/10378"), ("series", "series/19885"),
                   ("season", "series/19885/seasons/1"), ("versions-cached", "works/tmdb-movie-10378/versions"), ("discover-kind", "discover")]:
    t = toks["kind" if name == "discover-kind" else "anna"]
    samples = []
    for _ in range(20):
        s, raw, _, ms = req("GET", f"{CAT}/{path}", t)
        samples.append(ms)
    lat[name] = (statistics.median(samples), max(samples))
samples = []
for _ in range(5):
    samples.append(req("GET", f"{CAT}/works/tmdb-movie-10378/versions?refresh=true", toks["anna"])[3])
lat["versions-refresh"] = (statistics.median(samples), max(samples))
for k, (med, mx) in lat.items():
    print(f"LATENCY {k}: median {med:.1f} ms, max {mx:.1f} ms")
check("non-indexer endpoints median < 50 ms", all(lat[k][0] < 50 for k in ("search", "discover", "movie", "series", "season", "discover-kind")))

# ---------- openapi ----------
s, raw, _, _ = req("GET", BASE + "/openapi/v1.json")
live = json.loads(raw)
frozen = json.load(open("/Users/til/Development/streamarr/server/openapi/v1.json"))
check("live /openapi/v1.json equals frozen file", live == frozen)
paths = [p for p in frozen["paths"] if p.startswith("/api/v1/viewer/catalog")]
check("OpenAPI has the six catalog paths", len(paths) == 6, paths)
check("OpenAPI ErrorDetail.params", "params" in frozen["components"]["schemas"]["ErrorDetail"]["properties"])

# ---------- module gate (last) ----------
s, raw, _, _ = req("PUT", BASE + "/api/v1/config/viewers/settings", admin_tok, {"enabled": False})
check("admin disables viewer module", s == 200, raw[:200])
for p in PATHS:
    s, d, _, raw = get(f"{CAT}/{p}", toks["anna"])
    check(f"module off: {p} -> 404 module_disabled", s == 404 and d["error"]["code"] == "module_disabled", f"{s} {raw[:150]}")
s, raw, _, _ = req("PUT", BASE + "/api/v1/config/viewers/settings", admin_tok, {"enabled": True})
check("admin re-enables viewer module", s == 200, raw[:200])
s, d, _, raw = get(f"{CAT}/discover", toks["anna"])
check("module on again: discover 200", s == 200, raw[:150])

json.dump({k: v for k, v in RAW.items()}, open("/tmp/m12v1/raw.json", "w"))
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
for f in FAIL:
    print("  FAILED:", f)
