#!/usr/bin/env python3
"""Bounded local Streamarr Core contract fixture for the Jellyfin plugin CI smoke."""

from __future__ import annotations

import argparse
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlsplit


MAX_REQUEST_BYTES = 64 * 1024
API_KEY = os.environ.get("STREAMARR_FAKE_CORE_API_KEY", "")
COUNTS = {
    "caps": 0,
    "search": 0,
    "tv_search": 0,
    "tv_series": 0,
    "tv_season": 0,
    "resolve": 0,
    "events": 0,
    "close": 0,
    "auth_failures": 0,
}
COUNTS_LOCK = threading.Lock()
LAST_RESOLVE_REQUEST: Optional[dict[str, object]] = None

MOVIE = {
    "workId": "ci-smoke-work",
    "mediaType": "movie",
    "title": "Streamarr CI Smoke Movie",
    "year": 2026,
    "tmdbId": 990000,
    "runtimeMinutes": 90,
    "releases": [
        {
            "releaseId": "ci-smoke-release",
            "title": "CI.Smoke.Movie.1080p",
            "indexer": "ci-fixture",
            "sizeBytes": 1048576,
            "quality": {
                "resolution": "1080p",
                "source": "WEB-DL",
                "codec": "x264",
            },
            "languages": ["en"],
            "health": "healthy",
        },
        {
            "releaseId": "ci-smoke-release-alt",
            "title": "CI.Smoke.Movie.2160p",
            "indexer": "ci-fixture-alt",
            "sizeBytes": 3145728,
            "quality": {
                "resolution": "2160p",
                "source": "WEB-DL",
                "codec": "x265",
                "hdr": "HDR10",
                "audio": "DDP5.1",
            },
            "languages": ["de", "en"],
            "health": "healthy",
        },
    ],
}

SERIES = {
    "workId": "ci-smoke-series",
    "mediaType": "series",
    "title": "Streamarr CI Smoke Series",
    "year": 2026,
    "tmdbId": 990001,
    "imdbId": "tt9900001",
    "overview": "Deterministic TV hierarchy fixture for the Jellyfin smoke.",
    "runtimeMinutes": 45,
    "seasonCount": 1,
    "episodeCount": 2,
}

SEASON = {
    "workId": "ci-smoke-series-s01",
    "mediaType": "season",
    "tmdbId": 990001,
    "seasonNumber": 1,
    "title": "Season 1",
    "overview": "The deterministic smoke season.",
    "airDate": "2026-01-01",
    "episodeCount": 2,
}

EPISODES = [
    {
        "workId": "ci-smoke-series-s01e01",
        "mediaType": "episode",
        "tmdbId": 990001,
        "seriesTitle": "Streamarr CI Smoke Series",
        "seasonNumber": 1,
        "episodeNumber": 1,
        "title": "Available Episode",
        "overview": "Canonical episode with a ranked release.",
        "airDate": "2026-01-01",
        "runtimeMinutes": 45,
        "releases": [
            {
                "releaseId": "ci-smoke-tv-release",
                "title": "CI.Smoke.Series.S01E01.1080p",
                "indexer": "ci-fixture",
                "sizeBytes": 2097152,
                "quality": {
                    "resolution": "1080p",
                    "source": "WEB-DL",
                    "codec": "x264",
                },
                "languages": ["en"],
                "health": "healthy",
            },
            {
                "releaseId": "ci-smoke-tv-release-alt",
                "title": "CI.Smoke.Series.S01E01.720p",
                "indexer": "ci-fixture-alt",
                "sizeBytes": 1048576,
                "quality": {
                    "resolution": "720p",
                    "source": "WEB-DL",
                    "codec": "x264",
                },
                "languages": ["de"],
                "health": "healthy",
            },
        ],
    },
    {
        "workId": "ci-smoke-series-s01e02",
        "mediaType": "episode",
        "tmdbId": 990001,
        "seriesTitle": "Streamarr CI Smoke Series",
        "seasonNumber": 1,
        "episodeNumber": 2,
        "title": "Unavailable Episode",
        "overview": "Canonical episode deliberately lacking a release.",
        "airDate": "2026-01-08",
        "runtimeMinutes": 45,
        "releases": [],
    },
]

RESOLVABLE_RELEASES = {
    release["releaseId"]: {
        "workId": work["workId"],
        "sizeBytes": release["sizeBytes"],
        "runTimeTicks": work["runtimeMinutes"] * 60 * 10_000_000,
    }
    for work in [MOVIE, EPISODES[0]]
    for release in work["releases"]
}


def increment(name: str) -> None:
    with COUNTS_LOCK:
        COUNTS[name] += 1


class Handler(BaseHTTPRequestHandler):
    server_version = "StreamarrFakeCore/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def send_json(self, status: int, value: object) -> None:
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {API_KEY}"
        allowed = bool(API_KEY) and hmac.compare_digest(supplied, expected)
        if not allowed:
            increment("auth_failures")
            self.send_json(401, {"error": {"code": "unauthorized", "message": "Invalid API key"}})
        return allowed

    def bounded_body(self) -> Optional[bytes]:
        transfer_encoding = self.headers.get("Transfer-Encoding", "").strip().lower()
        if transfer_encoding:
            if transfer_encoding != "chunked":
                self.send_json(400, {"error": {"code": "bad_request", "message": "Unsupported transfer encoding"}})
                return None
            return self.bounded_chunked_body()

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": {"code": "bad_request", "message": "Invalid body length"}})
            return None
        if length < 0 or length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": {"code": "too_large", "message": "Request too large"}})
            return None
        return self.rfile.read(length)

    def bounded_chunked_body(self) -> Optional[bytes]:
        payload = bytearray()
        while True:
            size_line = self.rfile.readline(128)
            if not size_line or len(size_line) >= 128 or not size_line.endswith(b"\r\n"):
                self.send_json(400, {"error": {"code": "bad_request", "message": "Invalid chunk framing"}})
                return None
            try:
                chunk_size = int(size_line.split(b";", 1)[0].strip(), 16)
            except ValueError:
                self.send_json(400, {"error": {"code": "bad_request", "message": "Invalid chunk size"}})
                return None
            if chunk_size < 0 or len(payload) + chunk_size > MAX_REQUEST_BYTES:
                self.send_json(413, {"error": {"code": "too_large", "message": "Request too large"}})
                return None
            if chunk_size == 0:
                # Consume a small, bounded trailer section. The smoke client sends none.
                trailer_bytes = 0
                while True:
                    trailer = self.rfile.readline(1024)
                    trailer_bytes += len(trailer)
                    if not trailer or trailer == b"\r\n":
                        return bytes(payload)
                    if trailer_bytes > 8 * 1024:
                        self.send_json(400, {"error": {"code": "bad_request", "message": "Trailers too large"}})
                        return None
            chunk = self.rfile.read(chunk_size)
            terminator = self.rfile.read(2)
            if len(chunk) != chunk_size or terminator != b"\r\n":
                self.send_json(400, {"error": {"code": "bad_request", "message": "Invalid chunk framing"}})
                return None
            payload.extend(chunk)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed_url = urlsplit(self.path)
        path = parsed_url.path
        query = parse_qs(parsed_url.query, keep_blank_values=True)
        if path == "/api/v1/health":
            self.send_json(200, {"status": "healthy", "version": "ci-fake-core"})
            return
        if path == "/__smoke/state":
            with COUNTS_LOCK:
                snapshot = dict(COUNTS)
                snapshot["lastResolve"] = (
                    dict(LAST_RESOLVE_REQUEST) if LAST_RESOLVE_REQUEST is not None else None
                )
            self.send_json(200, snapshot)
            return
        if path.startswith("/api/v1/stream/ci-smoke-session-"):
            # The stream URL is the capability: direct remote-source players intentionally send
            # no Core machine key or Jellyfin credential when fetching it.
            payload = b"streamarr-smoke-media"
            self.send_response(200)
            self.send_header("Content-Type", "video/x-matroska")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if not self.authorized():
            return
        if path == "/api/v1/caps":
            increment("caps")
            self.send_json(200, {"mediaTypes": ["movie", "tv"], "categories": [], "providers": []})
            return
        if path == "/api/v1/search":
            increment("search")
            requested_types = query.get("type", [])
            results = [MOVIE] if not requested_types or requested_types == ["movie"] else []
            self.send_json(200, {"results": results})
            return
        if path == "/api/v1/tv/search":
            increment("tv_search")
            self.send_json(200, {"results": [SERIES]})
            return
        if path == "/api/v1/tv/990001":
            increment("tv_series")
            self.send_json(200, {"series": SERIES, "seasons": [SEASON]})
            return
        if path == "/api/v1/tv/990001/seasons/1":
            increment("tv_season")
            self.send_json(200, {"series": SERIES, "season": SEASON, "episodes": EPISODES})
            return
        self.send_json(404, {"error": {"code": "not_found", "message": "Not found"}})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlsplit(self.path).path
        body = self.bounded_body()
        if body is None or not self.authorized():
            return
        if path == "/api/v1/resolve":
            global LAST_RESOLVE_REQUEST
            try:
                request = json.loads(body or b"{}")
            except json.JSONDecodeError:
                self.send_json(400, {"error": {"code": "bad_request", "message": "Invalid JSON"}})
                return
            if not isinstance(request, dict):
                self.send_json(400, {"error": {"code": "bad_request", "message": "Invalid request"}})
                return

            release_id = request.get("releaseId")
            release = RESOLVABLE_RELEASES.get(release_id) if isinstance(release_id, str) else None
            if release is None:
                self.send_json(404, {"error": {"code": "not_found", "message": "Release not found"}})
                return
            if request.get("workId") != release["workId"]:
                self.send_json(400, {"error": {"code": "work_mismatch", "message": "Release does not belong to work"}})
                return

            # Expose only the bounded, non-secret attribution fields needed by the smoke. Never
            # retain arbitrary request properties even though the transport body is already capped.
            last_resolve = {
                "releaseId": release_id,
                "workId": request.get("workId"),
                "client": request.get("client"),
            }
            with COUNTS_LOCK:
                COUNTS["resolve"] += 1
                LAST_RESOLVE_REQUEST = last_resolve
            self.send_json(
                200,
                {
                    "releaseId": release_id,
                    "status": "ready",
                    "streamUrl": f"/api/v1/stream/ci-smoke-session-{release_id}",
                    "container": "mkv",
                    "sizeBytes": release["sizeBytes"],
                    "runTimeTicks": release["runTimeTicks"],
                    "mediaStreams": [{"type": "Video", "codec": "h264", "width": 1920, "height": 1080}],
                    "sessionTtlSeconds": 3600,
                },
            )
            return
        if path == "/api/v1/events":
            increment("events")
            self.send_response(204)
            self.end_headers()
            return
        if path.startswith("/api/v1/sessions/") and path.endswith("/close"):
            increment("close")
            self.send_response(204)
            self.end_headers()
            return
        self.send_json(404, {"error": {"code": "not_found", "message": "Not found"}})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ready-file", required=True)
    args = parser.parse_args()
    if not API_KEY:
        raise SystemExit("STREAMARR_FAKE_CORE_API_KEY is required")

    server = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
    Path(args.ready_file).write_text(str(server.server_port), encoding="utf-8")
    server.serve_forever(poll_interval=0.1)


if __name__ == "__main__":
    main()
