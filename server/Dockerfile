# Streamarr Core Server — multi-stage image (BRIEF §4 "Packaging").
#   1. build the React SPA           (node)
#   2. publish the ASP.NET Core app  (dotnet sdk), embedding the SPA in wwwroot
#   3. slim runtime with ffmpeg      (aspnet + ffmpeg for /resolve ffprobe)
#
# Build context is the repo root:  docker build -f server/Dockerfile .

# ---- 1. SPA -------------------------------------------------------------------------
FROM node:20-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
# schema.d.ts is committed, so the build needs no live OpenAPI generation.
RUN npm run build

# ---- 2. .NET publish ----------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY server/ server/
# Bring the freshly built SPA into the server's static web root (single-origin prod path).
COPY --from=web /web/dist/ server/src/Streamarr.Server/wwwroot/
RUN dotnet publish server/src/Streamarr.Server/Streamarr.Server.csproj \
      -c Release -o /app --no-self-contained

# ---- 3. runtime ---------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
# ffmpeg supplies ffprobe, which /resolve runs against the stream (BRIEF §6.2).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app ./
ENV ASPNETCORE_URLS=http://+:8080
ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080
ENTRYPOINT ["dotnet", "Streamarr.Server.dll"]
