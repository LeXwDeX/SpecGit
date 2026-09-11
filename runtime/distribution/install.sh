#!/bin/sh
# Download, verify and install the standalone SpecGit executable.
set -eu
version=${1:-latest}
install_dir=${2:-"$HOME/.local/bin"}
repo=https://github.com/LeXwDeX/SpecGit
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) platform=darwin-arm64 ;;
  Linux:x86_64) platform=linux-x64-gnu
    getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'Linux glibc is required; musl is unsupported.' ;;
  *) fail 'Supported platforms: macOS arm64, Linux x64 glibc, Windows x64 (install.ps1).' ;;
esac
if [ "$version" = latest ]; then
  resolved=$(curl --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 -fsSL -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
  case "$resolved" in "$repo/releases/tag/v"*) version=${resolved##*/v} ;; *) fail 'Cannot resolve the latest stable release.' ;; esac
fi
version=${version#v}
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Use a stable version such as 2.0.0, or latest.'
archive=specgit-$platform-$version.tgz
base=$repo/releases/download/v$version
scratch=$(mktemp -d)
staged=
trap 'rm -rf "$scratch"; if [ -n "$staged" ]; then rm -f "$staged"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 -fsSL "$base/SHASUMS256.txt" -o "$scratch/SHASUMS256.txt"
curl --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 -fsSL "$base/$archive" -o "$scratch/$archive"
expected=$(awk -v file="$archive" '$2 == file {print $1}' "$scratch/SHASUMS256.txt")
printf '%s\n' "$expected" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || fail 'Missing or invalid archive checksum.'
[ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" = 1 ] || fail 'Duplicate checksum entries.'
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$scratch/$archive" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$scratch/$archive" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || fail 'SHA-256 mismatch; existing installation was preserved.'
# Extract only the executable; archive paths cannot select the destination.
(cd "$scratch" && tar -xOf "./$archive" package/bin/specgit) > "$scratch/specgit"
chmod 755 "$scratch/specgit"
[ "$("$scratch/specgit" --human --version)" = "specgit $version" ] || fail 'Native version/platform check failed.'
mkdir -p "$install_dir"
[ ! -d "$install_dir/specgit" ] || fail 'The installation destination is a directory.'
staged=$(mktemp "$install_dir/.specgit-install.XXXXXX")
cat "$scratch/specgit" > "$staged"
chmod 755 "$staged"
mv -f "$staged" "$install_dir/specgit"
staged=
printf 'Installed SpecGit %s at %s/specgit\nAdd %s to PATH if needed.\n' "$version" "$install_dir" "$install_dir"
