#!/usr/bin/env python3
"""Captures Dev World fixture metadata from public TMDB web pages (no API key needed).

Usage: capture_tmdb.py movie:10378 movie:45745 tv:19885:1,2,3 > tmdb-capture.json
The output is merged by hand into ../fixtures/catalog.json; certifications that TMDB
only shows region-dependent on the web (TV) are captured as seen from the caller's region.
"""
import html
import json
import re
import sys
import time
import urllib.request

BASE = "https://www.themoviedb.org"
UA = "streamarr-devworld-fixture/1.0 (+https://github.com/)"


def fetch(path, lang):
    url = f"{BASE}{path}?language={lang}"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": lang})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return re.sub(r"\s+", " ", resp.read().decode("utf-8"))
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)
    return ""


def text(fragment):
    return html.unescape(re.sub(r"<[^>]+>", "", fragment or "")).strip() or None


def first(pattern, s, group=1):
    m = re.search(pattern, s)
    return m.group(group) if m else None


def image_path(url):
    return first(r"/t/p/[^/]+(/[^\"' ]+\.(?:jpg|png))", url or "")


def runtime_minutes(value):
    if not value:
        return None
    h = first(r"(\d+)h", value)
    m = first(r"(\d+)m", value)
    total = int(h or 0) * 60 + int(m or 0)
    return total or None


def page_common(s):
    images = re.findall(r'<meta property="og:image" content="([^"]*)"', s)
    posters = [image_path(u) for u in images if "/w500/" in u]
    backdrops = [image_path(u) for u in images if "/w780/" in u]
    facts = first(r'<div class="facts">(.*?)</div>', s) or ""
    return {
        "title": text(first(r'<meta property="og:title" content="([^"]*)"', s)),
        "year": int(first(r'<span class="tag release_date">\((\d{4})\)</span>', s) or 0) or None,
        "overview": text(first(r'<div class="overview" dir="auto"> ?(.*?)</div>', s)),
        "tagline": text(first(r'<h3 class="tagline" dir="auto">(.*?)</h3>', s)),
        "genres": [text(g) for g in re.findall(r'<a href="/genre/[^"]*">([^<]*)</a>', first(r'<span class="genres">(.*?)</span>', facts) or "")],
        "runtimeMinutes": runtime_minutes(text(first(r'<span class="runtime">(.*?)</span>', facts))),
        "regionCertification": text(first(r'<span class="certification">(.*?)</span>', facts)),
        "userScorePercent": int(first(r'data-percent="(\d+)"', s) or 0) or None,
        "posterPath": posters[0] if posters else None,
        "backdropPath": backdrops[0] if backdrops else None,
    }


def movie(tmdb_id):
    en = fetch(f"/movie/{tmdb_id}", "en-US")
    de = fetch(f"/movie/{tmdb_id}", "de-DE")
    rel = fetch(f"/movie/{tmdb_id}/releases", "en-US")
    certs = {}
    for m in re.finditer(r'<h2 id="([A-Z]{2})" class="release">.*?<tbody>(.*?)</tbody>', rel):
        for row in re.findall(r"<tr>(.*?)</tr>", m.group(2)):
            cells = [text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row)]
            if len(cells) > 1 and cells[1]:
                certs[m.group(1)] = cells[1]
                break
    e, d = page_common(en), page_common(de)
    return {
        "kind": "movie", "tmdbId": tmdb_id, **e,
        "de": {"title": d["title"], "overview": d["overview"], "tagline": d["tagline"], "genres": d["genres"]},
        "certifications": certs,
    }


def iso_date(value):
    try:
        return time.strftime("%Y-%m-%d", time.strptime(value, "%B %d, %Y"))
    except (TypeError, ValueError):
        return None


def episodes(s):
    out = []
    for card in s.split('<div class="card" data-object-id=')[1:]:
        number = first(r'data-episode-number="(\d+)"', card)
        if number is None:
            continue
        date = text(first(r'<span class="date">(.*?)</span>', card))
        out.append({
            "episodeNumber": int(number),
            "title": text(first(r"<h3><a [^>]*>(.*?)</a></h3>", card)),
            "airDate": iso_date(date),
            "runtimeMinutes": runtime_minutes(text(first(r'<span class="runtime">(.*?)</span>', card))),
            "overview": text(first(r'<div class="overview"> ?<p>(.*?)</p>', card)),
            "stillPath": image_path(first(r'class="backdrop w-full" src="([^"]*)"', card)),
        })
    return out


def tv(tmdb_id, seasons):
    en = fetch(f"/tv/{tmdb_id}", "en-US")
    de = fetch(f"/tv/{tmdb_id}", "de-DE")
    e, d = page_common(en), page_common(de)
    result = {
        "kind": "tv", "tmdbId": tmdb_id, **e,
        "de": {"title": d["title"], "overview": d["overview"], "tagline": d["tagline"], "genres": d["genres"]},
        "seasons": [],
    }
    for n in seasons:
        s_en = fetch(f"/tv/{tmdb_id}/season/{n}", "en-US")
        s_de = fetch(f"/tv/{tmdb_id}/season/{n}", "de-DE")
        eps_de = {x["episodeNumber"]: x for x in episodes(s_de)}
        eps = episodes(s_en)
        for ep in eps:
            other = eps_de.get(ep["episodeNumber"], {})
            ep["de"] = {"title": other.get("title"), "overview": other.get("overview")}
        posters = [image_path(u) for u in re.findall(r'<meta property="og:image" content="([^"]*)"', s_en)]
        result["seasons"].append({
            "seasonNumber": n,
            "title": text(first(r"<h2[^>]*><a [^>]*>([^<]*)</a> <span", s_en)) or f"Season {n}",
            "posterPath": posters[0] if posters else None,
            "episodes": eps,
        })
    return result


def main(args):
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0 if args else 2)
    items = []
    for arg in args:
        kind, _, rest = arg.partition(":")
        if kind == "movie":
            items.append(movie(int(rest)))
        else:
            tmdb_id, _, seasons = rest.partition(":")
            items.append(tv(int(tmdb_id), [int(x) for x in seasons.split(",") if x]))
    json.dump(items, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main(sys.argv[1:])
