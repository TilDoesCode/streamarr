# Streamarr Core Server — multi-stage image (BRIEF §4 "Packaging").
#   1. build the React SPA           (node)
#   1b. export the viewer web app    (node, Expo web export of client/, served under /watch)
#   2. publish the ASP.NET Core app  (dotnet sdk), embedding the SPA in wwwroot
#   3. slim runtime with ffmpeg      (aspnet + ffmpeg for /resolve ffprobe)
#
# Build context is the repo root:  docker build -f server/Dockerfile .

# ---- 1. SPA -------------------------------------------------------------------------
FROM node:24-trixie-slim@sha256:366fdef91728b1b7fa18c84fba63b6e79ed77b7e10cc206878e9705da4d7b169 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* web/.npmrc ./
RUN npm ci
COPY web/ ./
# schema.d.ts is committed, so the build needs no live OpenAPI generation.
RUN npm run build

# ---- 1b. Viewer web app -------------------------------------------------------------
FROM node:24-trixie-slim@sha256:366fdef91728b1b7fa18c84fba63b6e79ed77b7e10cc206878e9705da4d7b169 AS viewer-web
WORKDIR /client
# patches/ must be present for the patch-package postinstall hook.
COPY client/package.json client/package-lock.json client/.npmrc ./
COPY client/patches/ patches/
RUN npm ci
COPY client/ ./
RUN EXPO_BASE_URL=/watch npx expo export --platform web --output-dir dist

# ---- 2. .NET publish ----------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0-noble@sha256:2ae6f287fa860c15f121474cf864b86765beb87507bbc3f48661a4f6f1ffc2b5 AS build
WORKDIR /src
COPY server/ server/
# Bring the freshly built SPA into the server's static web root (single-origin prod path).
COPY --from=web /web/dist/ server/src/Streamarr.Server/wwwroot/
RUN dotnet publish server/src/Streamarr.Server/Streamarr.Server.csproj \
      -c Release -o /app --no-self-contained

# ---- 3. runtime ---------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:8.0-noble@sha256:d72743fde6e26a853eaa5dd58a6e30cfbedf17186fe2aed6ff283b82efee9249 AS runtime
ARG TARGETARCH
# ffmpeg supplies ffprobe for /resolve and the server-side transcoder; the VA-API drivers let
# a passed-through /dev/dri (Intel iHD, AMD radeonsi) accelerate it. curl backs the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl mesa-va-drivers \
    && if [ "$TARGETARCH" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver-non-free; fi \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /app/data /app/keys \
    && chown -R app:app /app
COPY --from=build --chown=app:app /app ./
# Default Streamarr:ViewerWebPath (<ContentRoot>/viewer-web).
COPY --from=viewer-web --chown=app:app /client/dist/ ./viewer-web/
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production
ENV Streamarr__ConnectionString="Data Source=/app/data/streamarr.db"
ENV Streamarr__DataProtectionKeysPath=/app/keys
ENV Streamarr__NzbCachePath=/app/data/nzb
ENV Streamarr__Repair__WorkspacePath=/app/data/repair
ENV Streamarr__PreDownload__CachePath=/app/data/predownload
ENV Streamarr__Transcoding__WorkspacePath=/app/data/transcode
ENV Streamarr__Transcoding__SamplesPath=/app/data/transcoding-samples
EXPOSE 8080
USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/v1/health || exit 1
ENTRYPOINT ["dotnet", "Streamarr.Server.dll"]
