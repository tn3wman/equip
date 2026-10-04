const NODE_VERSION = "22.20.0";

export function shellInstaller(origin: string, _skillsVersion: string) {
  return `#!/bin/sh
# The first install trusts this HTTPS origin and its artifact hash. The installed
# CLI pins Equip's release key and requires signed manifests for later updates.
set -eu
install_root="${"$"}{EQUIP_INSTALL_ROOT:-${"$"}HOME/.equip}"
runtime="${"$"}install_root/runtime"
bin_dir="${"$"}install_root/bin"
node_dir="${"$"}install_root/node"
node_bin=""

compatible_node() {
  "${"$"}1" -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<20))process.exit(1)" >/dev/null 2>&1
}

if [ "${"$"}{EQUIP_FORCE_BUNDLED_NODE:-0}" != 1 ] && command -v node >/dev/null 2>&1 && compatible_node "${"$"}(command -v node)" && command -v npm >/dev/null 2>&1; then
  node_bin="${"$"}(command -v node)"
else
  os="${"$"}(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="${"$"}(uname -m)"
  case "${"$"}os" in darwin|linux) ;; *) printf 'Equip cannot install Node automatically on %s. Install Node 22.20 or newer.\n' "${"$"}os" >&2; exit 1;; esac
  case "${"$"}arch" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) printf 'Equip does not have a bundled Node build for %s.\n' "${"$"}arch" >&2; exit 1;; esac
  archive="node-v${NODE_VERSION}-${"$"}os-${"$"}arch.tar.gz"
  work="${"$"}install_root/.node-download"
  rm -rf "${"$"}work"
  mkdir -p "${"$"}work" "${"$"}node_dir"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "${"$"}work/SHASUMS256.txt"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${"$"}archive" -o "${"$"}work/${"$"}archive"
  expected="${"$"}(awk -v file="${"$"}archive" '${"$"}2 == file { print ${"$"}1 }' "${"$"}work/SHASUMS256.txt")"
  [ -n "${"$"}expected" ] || { printf 'Node checksum was not published for %s.\n' "${"$"}archive" >&2; exit 1; }
  if command -v shasum >/dev/null 2>&1; then actual="${"$"}(shasum -a 256 "${"$"}work/${"$"}archive" | awk '{print ${"$"}1}')";
  elif command -v sha256sum >/dev/null 2>&1; then actual="${"$"}(sha256sum "${"$"}work/${"$"}archive" | awk '{print ${"$"}1}')";
  else printf 'A SHA-256 tool is required to verify Node.\n' >&2; exit 1; fi
  [ "${"$"}actual" = "${"$"}expected" ] || { printf 'Node download checksum mismatch.\n' >&2; exit 1; }
  rm -rf "${"$"}node_dir"
  mkdir -p "${"$"}node_dir"
  tar -xzf "${"$"}work/${"$"}archive" -C "${"$"}node_dir" --strip-components=1
  rm -rf "${"$"}work"
  node_bin="${"$"}node_dir/bin/node"
fi

mkdir -p "${"$"}runtime" "${"$"}bin_dir"
curl -fsSL "${origin}/cli/manifest" -o "${"$"}runtime/manifest.json"
"${"$"}node_bin" -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[1]));const o=new URL(process.argv[2]);if(m.origin!==o.origin||new URL(m.url).origin!==o.origin||new URL(m.url).pathname!=='/cli/equip.cjs'){console.error('Equip release origin mismatch.');process.exit(1)}" "${"$"}runtime/manifest.json" "${origin}"
curl -fsSL "${origin}/cli/equip.cjs" -o "${"$"}runtime/equip.cjs.download"
"${"$"}node_bin" -e "const fs=require('fs'),c=require('crypto');const m=JSON.parse(fs.readFileSync(process.argv[1]));const actual=c.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex');if(actual!==m.sha256){console.error('Equip CLI checksum mismatch.');process.exit(1)}" "${"$"}runtime/manifest.json" "${"$"}runtime/equip.cjs.download"
mv "${"$"}runtime/equip.cjs.download" "${"$"}runtime/equip.cjs"
if [ "${"$"}node_bin" = "${"$"}node_dir/bin/node" ]; then npm_cli="${"$"}node_dir/lib/node_modules/npm/bin/npm-cli.js"; else npm_cli="${"$"}(command -v npm)"; fi
skills_version="${"$"}("${"$"}node_bin" -p "JSON.parse(require('fs').readFileSync(process.argv[1])).skillsVersion" "${"$"}runtime/manifest.json")"
expected_integrity="${"$"}("${"$"}node_bin" -p "JSON.parse(require('fs').readFileSync(process.argv[1])).skillsIntegrity" "${"$"}runtime/manifest.json")"
if [ -f "${"$"}npm_cli" ]; then registry_integrity="${"$"}("${"$"}node_bin" "${"$"}npm_cli" view "skills@${"$"}skills_version" dist.integrity --json | tr -d '\"')";
else registry_integrity="${"$"}("${"$"}npm_cli" view "skills@${"$"}skills_version" dist.integrity --json | tr -d '\"')"; fi
[ "${"$"}registry_integrity" = "${"$"}expected_integrity" ] || { printf 'Skills package integrity does not match the release manifest.\n' >&2; exit 1; }
if [ -f "${"$"}npm_cli" ]; then "${"$"}node_bin" "${"$"}npm_cli" install --silent --no-audit --no-fund --omit=dev --prefix "${"$"}runtime" "skills@${"$"}skills_version";
else "${"$"}npm_cli" install --silent --no-audit --no-fund --omit=dev --prefix "${"$"}runtime" "skills@${"$"}skills_version"; fi
"${"$"}node_bin" -e "const p=require(process.argv[1]);if(p.version!==process.argv[2])throw Error('Installed skills version mismatch.')" "${"$"}runtime/node_modules/skills/package.json" "${"$"}skills_version"
cat > "${"$"}runtime/write-launcher.cjs" <<'EQUIP_LAUNCHER'
const fs = require('fs');
const q = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
const [output, origin, root, runtime, npm, node] = process.argv.slice(2);
fs.writeFileSync(output, ['#!/bin/sh', 'export EQUIP_SERVER=' + q(origin), 'export EQUIP_HOME=' + q(root + '/state'), 'export EQUIP_SKILLS_ROOT=' + q(runtime + '/node_modules/skills'), 'export EQUIP_NPM_CLI=' + q(npm), 'exec ' + q(node) + ' ' + q(runtime + '/equip.cjs') + ' "${"$"}@"', ''].join('\\n'), { mode: 0o755 });
EQUIP_LAUNCHER
"${"$"}node_bin" "${"$"}runtime/write-launcher.cjs" "${"$"}bin_dir/equip" "${origin}" "${"$"}install_root" "${"$"}runtime" "${"$"}npm_cli" "${"$"}node_bin"
rm -f "${"$"}runtime/write-launcher.cjs"
chmod 755 "${"$"}bin_dir/equip"
if [ "${"$"}{EQUIP_NO_PROFILE:-0}" != 1 ]; then
  public_bin="${"$"}HOME/.local/bin/equip"
  if [ -d "${"$"}HOME/.local/bin" ] && [ -w "${"$"}HOME/.local/bin" ] && printf '%s' ":${"$"}PATH:" | grep -q ":${"$"}HOME/.local/bin:"; then
    if [ ! -e "${"$"}public_bin" ] && [ ! -L "${"$"}public_bin" ]; then ln -s "${"$"}bin_dir/equip" "${"$"}public_bin";
    elif [ -L "${"$"}public_bin" ] && [ "${"$"}(readlink "${"$"}public_bin")" = "${"$"}bin_dir/equip" ]; then :;
    else printf 'Equip left existing %s unchanged. Use %s directly.\n' "${"$"}public_bin" "${"$"}bin_dir/equip" >&2; fi
  else
    case "${"$"}{SHELL:-}" in */zsh) profile="${"$"}HOME/.zshrc";; */bash) profile="${"$"}HOME/.bashrc";; *) profile="${"$"}HOME/.profile";; esac
    marker="# Equip CLI path: ${"$"}bin_dir"
    grep -Fq "${"$"}marker" "${"$"}profile" 2>/dev/null || printf '\n%s\nexport PATH="%s:${"$"}PATH"\n' "${"$"}marker" "${"$"}bin_dir" >> "${"$"}profile"
  fi
fi
headless=""; no_service=""
[ "${"$"}{EQUIP_HEADLESS:-0}" = 1 ] && headless="--headless"
[ "${"$"}{EQUIP_NO_SERVICE:-0}" = 1 ] && no_service="--no-service"
if [ "${"$"}{EQUIP_HEADLESS:-0}" = 1 ] || ! (: < /dev/tty) 2>/dev/null; then "${"$"}bin_dir/equip" connect ${"$"}headless ${"$"}no_service; else "${"$"}bin_dir/equip" connect ${"$"}headless ${"$"}no_service < /dev/tty; fi
`;
}

export function powershellInstaller(origin: string, _skillsVersion: string) {
  return `# The first install trusts this HTTPS origin and its artifact hash. The installed
# CLI pins Equip's release key and requires signed manifests for later updates.
$ErrorActionPreference = 'Stop'
$installRoot = if ($env:EQUIP_INSTALL_ROOT) { $env:EQUIP_INSTALL_ROOT } else { Join-Path $HOME '.equip' }
$runtime = Join-Path $installRoot 'runtime'
$nodeDir = Join-Path $installRoot 'node'
$binDir = Join-Path $installRoot 'bin'
function Get-Sha256([string]$path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($path)
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
$useBundled = $env:EQUIP_FORCE_BUNDLED_NODE -eq '1'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and -not $useBundled) { $parts = (& $node.Source -p "process.versions.node").Split('.'); $useBundled = [int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 20) }
if (-not $node -or $useBundled) {
  $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
  $archive = 'node-v${NODE_VERSION}-win-' + $arch + '.zip'
  $work = Join-Path $installRoot '.node-download'; New-Item -ItemType Directory -Force -Path $work | Out-Null
  Invoke-WebRequest "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -UseBasicParsing -OutFile (Join-Path $work 'SHASUMS256.txt')
  Invoke-WebRequest "https://nodejs.org/dist/v${NODE_VERSION}/$archive" -UseBasicParsing -OutFile (Join-Path $work $archive)
  $line = Select-String -Path (Join-Path $work 'SHASUMS256.txt') -Pattern ([regex]::Escape($archive) + '$') | Select-Object -First 1
  if (-not $line) { throw 'Node checksum was not published.' }
  $expected = $line.Line.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0].ToLower()
  $actual = Get-Sha256 (Join-Path $work $archive)
  if ($actual -ne $expected) { throw 'Node download checksum mismatch.' }
  Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive (Join-Path $work $archive) $work -Force
  Move-Item (Join-Path $work $archive.Replace('.zip','')) $nodeDir; Remove-Item $work -Recurse -Force
  $nodePath = Join-Path $nodeDir 'node.exe'
} else { $nodePath = $node.Source }
New-Item -ItemType Directory -Force -Path $runtime,$binDir | Out-Null
Invoke-WebRequest '${origin}/cli/manifest' -UseBasicParsing -OutFile (Join-Path $runtime 'manifest.json')
Invoke-WebRequest '${origin}/cli/equip.cjs' -UseBasicParsing -OutFile (Join-Path $runtime 'equip.cjs.download')
$manifest = Get-Content (Join-Path $runtime 'manifest.json') | ConvertFrom-Json
if ($manifest.origin -ne '${origin}' -or ([Uri]$manifest.url).GetLeftPart([UriPartial]::Authority) -ne '${origin}' -or ([Uri]$manifest.url).AbsolutePath -ne '/cli/equip.cjs') { throw 'Equip release origin mismatch.' }
$cliHash = Get-Sha256 (Join-Path $runtime 'equip.cjs.download')
if ($cliHash -ne $manifest.sha256.ToLower()) { throw 'Equip CLI checksum mismatch.' }
Move-Item (Join-Path $runtime 'equip.cjs.download') (Join-Path $runtime 'equip.cjs') -Force
$npmCli = if (Test-Path (Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js')) { Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js' } else { (Get-Command npm).Source }
$skillsVersion = $manifest.skillsVersion
$expectedIntegrity = $manifest.skillsIntegrity
$registryIntegrity = if ($npmCli.EndsWith('.js')) { & $nodePath $npmCli view "skills@$skillsVersion" dist.integrity --json } else { & $npmCli view "skills@$skillsVersion" dist.integrity --json }
if (($registryIntegrity | ConvertFrom-Json) -ne $expectedIntegrity) { throw 'Skills package integrity does not match the release manifest.' }
if ($npmCli.EndsWith('.js')) { & $nodePath $npmCli install --silent --no-audit --no-fund --omit=dev --prefix $runtime "skills@$skillsVersion" } else { & $npmCli install --silent --no-audit --no-fund --omit=dev --prefix $runtime "skills@$skillsVersion" }
if ($LASTEXITCODE -ne 0) { throw "npm failed with exit code $LASTEXITCODE" }
$installedSkills = Get-Content (Join-Path $runtime 'node_modules/skills/package.json') | ConvertFrom-Json
if ($installedSkills.version -ne $skillsVersion) { throw 'Installed skills version mismatch.' }
$newline = [Environment]::NewLine
$launcherPath = Join-Path $binDir 'equip.cmd'
$launcher = '@echo off' + $newline + 'set "EQUIP_SERVER=${origin}"' + $newline + 'set "EQUIP_HOME=' + $installRoot + '\\state"' + $newline + 'set "EQUIP_SKILLS_ROOT=' + $runtime + '\\node_modules\\skills"' + $newline + 'set "EQUIP_NPM_CLI=' + $npmCli + '"' + $newline + '"' + $nodePath + '" "' + $runtime + '\\equip.cjs" %*'
Set-Content $launcherPath $launcher -Encoding Ascii
if ($env:EQUIP_NO_PROFILE -ne '1') {
  $collision = Get-Command equip -ErrorAction SilentlyContinue
  if ($collision -and [IO.Path]::GetFullPath($collision.Source) -ne [IO.Path]::GetFullPath($launcherPath)) { Write-Warning "Existing equip command left unchanged at $($collision.Source). Run $launcherPath directly." }
  else {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if (-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $binDir.TrimEnd('\\') })) { [Environment]::SetEnvironmentVariable('Path', (($parts + $binDir) -join ';'), 'User') }
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\\') -ieq $binDir.TrimEnd('\\') })) { $env:Path = $env:Path + ';' + $binDir }
  }
}
$args = @('connect'); if ($env:EQUIP_HEADLESS -eq '1') { $args += '--headless' }; if ($env:EQUIP_NO_SERVICE -eq '1') { $args += '--no-service' }
& (Join-Path $binDir 'equip.cmd') @args
`;
}
