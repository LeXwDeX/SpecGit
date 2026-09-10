$ErrorActionPreference = 'Stop'
$diagnosticRoot = Join-Path $env:RUNNER_TEMP 'specgit-install-diagnostics'
$public = Join-Path $diagnosticRoot 'public'
$raw = Join-Path $diagnosticRoot 'npm-raw'
New-Item -ItemType Directory -Force $public, $raw | Out-Null
$stopFile = Join-Path $diagnosticRoot 'stop'
if (Test-Path $stopFile) { Remove-Item $stopFile }
$env:npm_config_timing = 'true'
$env:npm_config_logs_dir = $raw
$env:npm_config_logs_max = '1000'
$env:VITEST_MAX_WORKERS = '1'
# Store only process identity and counters. Never collect command lines or env.
$monitor = Start-Job -ArgumentList $public, $stopFile -ScriptBlock {
  param($outputDirectory, $stop)
  $deadline = (Get-Date).AddSeconds(800)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $stop)) {
    $sample = @{
      time = (Get-Date).ToUniversalTime().ToString('o')
      processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '^(node|git|bash|sh|pwsh|powershell|cmd|MsMpEng)\.exe$'
      } | Select-Object Name, ProcessId, ParentProcessId, CreationDate,
          UserModeTime, KernelModeTime, WorkingSetSize)
    }
    $sample | ConvertTo-Json -Depth 4 -Compress |
      Add-Content (Join-Path $outputDirectory 'processes.jsonl')
    Start-Sleep -Seconds 5
  }
}
@{ driverPid = $PID; started = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json | Set-Content (Join-Path $public 'driver.json')
$testExit = 1
try {
  & node ./node_modules/vitest/vitest.mjs run test/specgit-e2e/install-smoke.e2e.test.ts test/specgit-e2e/external-matrix.e2e.test.ts --reporter=default --reporter=json --outputFile.json="$public/vitest.json"
  $testExit = $LASTEXITCODE
  & node ./scripts/windows-install-probe.mjs $diagnosticRoot
  if ($LASTEXITCODE -ne 0) { throw 'Installation control probe failed.' }
} finally {
  New-Item -ItemType File -Force $stopFile | Out-Null
  Stop-Job $monitor
  Remove-Job $monitor
  # npm debug logs can contain registry configuration. Export numeric timers only.
  & node ./scripts/windows-install-probe.mjs $diagnosticRoot --sanitize-only
}
exit $testExit
