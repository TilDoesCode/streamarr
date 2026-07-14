# Streamarr Core Server — multi-stage image (BRIEF §4 "Packaging").
#   1. build the React SPA           (node)
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

# ---- 2. .NET publish ----------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0-noble@sha256:08f003ba31fca1aeed32d5a076f62dc3b592faa0a811b072aa245321dd09f0ab AS build
WORKDIR /src
COPY server/ server/
# Bring the freshly built SPA into the server's static web root (single-origin prod path).
COPY --from=web /web/dist/ server/src/Streamarr.Server/wwwroot/
RUN dotnet publish server/src/Streamarr.Server/Streamarr.Server.csproj \
      -c Release -o /app --no-self-contained

# ---- 3. runtime ---------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:8.0-noble@sha256:77526aac4254c2b26764c2ab09700f6bdbcad2e2cb748e0d57bc01ebdced6515 AS runtime
# ffmpeg supplies ffprobe, which /resolve runs against the stream (BRIEF §6.2);
# curl backs the compose healthcheck (GET /api/v1/health).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /app/data /app/keys \
    && chown -R app:app /app
COPY --from=build --chown=app:app /app ./
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production
ENV Streamarr__ConnectionString="Data Source=/app/data/streamarr.db"
ENV Streamarr__DataProtectionKeysPath=/app/keys
EXPOSE 8080
USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/v1/health || exit 1
ENTRYPOINT ["dotnet", "Streamarr.Server.dll"]
