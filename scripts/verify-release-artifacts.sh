#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || {
  echo "Usage: $0 <MAJOR.MINOR.PATCH> <artifact-directory>" >&2
  exit 2
}

version="${1#v}"
artifact_dir="$(cd -- "$2" && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/streamarr-verify.XXXXXX")"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

(
  cd "$artifact_dir"
  if command -v sha256sum >/dev/null; then
    sha256sum --check SHA256SUMS
  else
    shasum -a 256 --check SHA256SUMS
  fi
)

unzip -q "$artifact_dir/streamarr-jellyfin-$version.zip" -d "$tmp_dir/plugin"
for file in Streamarr.Plugin.dll meta.json; do
  test -s "$tmp_dir/plugin/$file"
done

# Guard against the exact incident this repo already shipped once: meta.json said
# 0.9.2.0 but the compiled Streamarr.Plugin.dll's AssemblyVersion/FileVersion were
# still 0.8.0.0, because those were hardcoded as separate literals in
# Streamarr.Plugin.csproj and didn't track -p:Version passed by package-release.sh.
# The csproj no longer hardcodes them (see the comment there), but this check makes
# sure nobody reintroduces that drift without a release ever noticing.
command -v dotnet >/dev/null || {
  echo "dotnet is required to verify the compiled plugin's assembly version." >&2
  exit 1
}
checker_dir="$tmp_dir/assembly-version-check"
mkdir -p "$checker_dir"
cat > "$checker_dir/checker.csproj" <<'CSPROJ'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Exe</OutputType>
  </PropertyGroup>
</Project>
CSPROJ
cat > "$checker_dir/Program.cs" <<'CS'
var path = args[0];
var asm = System.Reflection.AssemblyName.GetAssemblyName(path);
var fvi = System.Diagnostics.FileVersionInfo.GetVersionInfo(path);
System.Console.WriteLine($"{asm.Version}|{fvi.FileVersion}");
CS
version_info="$(dotnet run --project "$checker_dir" --configuration Release -- "$tmp_dir/plugin/Streamarr.Plugin.dll")"
assembly_version="${version_info%%|*}"
file_version="${version_info##*|}"
expected_assembly_version="$version.0"
[[ "$assembly_version" == "$expected_assembly_version" && "$file_version" == "$expected_assembly_version" ]] || {
  echo "Streamarr.Plugin.dll has AssemblyVersion=$assembly_version FileVersion=$file_version but the release version is $expected_assembly_version." >&2
  echo "Check Streamarr.Plugin.csproj for a reintroduced hardcoded Version/AssemblyVersion/FileVersion." >&2
  exit 1
}

# The Jellyfin plugin-repository manifest must be valid JSON and advertise this
# release's plugin zip (matching sourceUrl and MD5 checksum) so an existing
# Jellyfin server can install it from a URL.
test -s "$artifact_dir/manifest.json"
if command -v md5sum >/dev/null; then
  zip_md5="$(md5sum "$artifact_dir/streamarr-jellyfin-$version.zip" | cut -d ' ' -f 1)"
else
  zip_md5="$(md5 -q "$artifact_dir/streamarr-jellyfin-$version.zip")"
fi
jq -e \
  --arg version "$version.0" \
  --arg checksum "$zip_md5" \
  --arg sourceUrl "streamarr-jellyfin-$version.zip" \
  '.[0].versions[0] as $v
   | $v.version == $version
   and $v.checksum == $checksum
   and ($v.sourceUrl | endswith($sourceUrl))' \
  "$artifact_dir/manifest.json" >/dev/null

mkdir "$tmp_dir/home"
tar -xzf "$artifact_dir/streamarr-home-$version.tar.gz" -C "$tmp_dir/home"
for file in compose.yml compose.komodo.yml compose.proxy.yml .env.example README.md plugin/Streamarr.Plugin.dll plugin/meta.json; do
  test -s "$tmp_dir/home/$file"
done
grep -Fq "STREAMARR_IMAGE=ghcr.io/tildoescode/streamarr:$version" "$tmp_dir/home/.env.example"

STREAMARR_API_KEY=verify-only-machine-key-0123456789abcdef \
STREAMARR_ADMIN_PASSWORD=verify-only-admin-password \
  docker compose --env-file "$tmp_dir/home/.env.example" \
    -f "$tmp_dir/home/compose.yml" config --quiet

STREAMARR_API_KEY=verify-only-machine-key-0123456789abcdef \
STREAMARR_ADMIN_PASSWORD=verify-only-admin-password \
  docker compose --env-file "$tmp_dir/home/.env.example" \
    -f "$tmp_dir/home/compose.yml" --profile jellyfin config --quiet

STREAMARR_API_KEY=verify-only-machine-key-0123456789abcdef \
STREAMARR_ADMIN_PASSWORD=verify-only-admin-password \
  docker compose --env-file "$tmp_dir/home/.env.example" \
    -f "$tmp_dir/home/compose.komodo.yml" config --quiet

STREAMARR_API_KEY=verify-only-machine-key-0123456789abcdef \
STREAMARR_ADMIN_PASSWORD=verify-only-admin-password \
STREAMARR_TRUSTED_PROXY=172.18.0.2 \
STREAMARR_TRUSTED_ORIGIN=https://streamarr.home.example \
  docker compose --env-file "$tmp_dir/home/.env.example" \
    -f "$tmp_dir/home/compose.yml" -f "$tmp_dir/home/compose.proxy.yml" config --quiet

echo "Verified release artifacts for $version"
