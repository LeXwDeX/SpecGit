$ErrorActionPreference = 'Stop'
$diagnosticRoot = Join-Path $env:RUNNER_TEMP "specgit-watch-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
if (Test-Path $diagnosticRoot) { throw 'Observer diagnostic destination already exists.' }
$public = Join-Path $diagnosticRoot 'public'
$raw = Join-Path $diagnosticRoot 'raw'
New-Item -ItemType Directory $public, $raw -Force | Out-Null
Push-Location runtime
try {
  & cargo test --locked --features test-fixtures --test assets windows_atomic_replace -- --nocapture *> (Join-Path $public 'atomic-replace.log')
  $atomicExit = $LASTEXITCODE
  @{ exit = $atomicExit } | ConvertTo-Json | Set-Content (Join-Path $public 'atomic-replace-result.json')
  if ($atomicExit -ne 0) { exit $atomicExit }
  & cargo test --locked --features test-fixtures --test watch --no-run *> (Join-Path $public 'build.log')
  if ($LASTEXITCODE -ne 0) { throw 'Observer test build failed.' }
  $tests = @(
    'ordinary_local_edits_supersede_the_assessment_without_losing_the_live_subscription',
    'unpushed_commits_remain_pending_for_multiple_polls_then_native_push_resumes',
    'final_local_revalidation_is_bounded_and_leaves_a_resumable_receipt'
  )
  $results = @()
  foreach ($test in $tests) {
    $env:SPECGIT_WATCH_DIAGNOSTICS = Join-Path $public $test
    $trace = Join-Path $raw "$test.jsonl"
    $env:GIT_TRACE2_EVENT = $trace.Replace('\', '/')
    $env:GIT_TRACE2_ENV_VARS = ''
    $env:GIT_TRACE2_CONFIG_PARAMS = ''
    $started = [Diagnostics.Stopwatch]::StartNew()
    & cargo test --locked --features test-fixtures --test watch $test -- --exact --nocapture *> (Join-Path $public "$test.log")
    $exitCode = $LASTEXITCODE
    $started.Stop()
    $events = @()
    if (Test-Path $trace) {
      foreach ($line in Get-Content $trace) {
        $event = $line | ConvertFrom-Json
        if ($event.event -eq 'start') {
          # Export command categories, never arbitrary arguments or environment.
          $operation = if ($event.argv.Count -gt 1 -and $event.argv[1] -in @('rev-parse', 'remote', 'status', 'merge-base', 'commit', 'maintenance', 'init', 'config', 'add')) { $event.argv[1] } else { 'other' }
          $events += @{ event = 'start'; time = $event.time; sid = $event.sid; operation = $operation }
        } elseif ($event.event -eq 'exit') {
          $events += @{ event = 'exit'; time = $event.time; sid = $event.sid; elapsed_seconds = $event.t_abs; code = $event.code }
        }
      }
    }
    $events | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $public "$test.git.json")
    $results += @{ test = $test; exit = $exitCode; elapsed_ms = $started.ElapsedMilliseconds; git_processes = @($events | Where-Object { $_.event -eq 'start' }).Count }
  }
  $results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $public 'results.json')
  # Reproduce the normal suite's concurrent execution after the isolated controls.
  $env:SPECGIT_WATCH_DIAGNOSTICS = Join-Path $public 'full-suite'
  $env:GIT_TRACE2_EVENT = (Join-Path $raw 'full-suite.jsonl').Replace('\', '/')
  & cargo test --locked --features test-fixtures --test watch -- --nocapture *> (Join-Path $public 'full-suite.log')
  $suiteExit = $LASTEXITCODE
  @{ exit = $suiteExit } | ConvertTo-Json | Set-Content (Join-Path $public 'full-suite-result.json')
  if ($suiteExit -ne 0) { exit $suiteExit }
  if (@($results | Where-Object { $_.exit -ne 0 }).Count -gt 0) { exit 1 }
} finally {
  Remove-Item Env:SPECGIT_WATCH_DIAGNOSTICS -ErrorAction SilentlyContinue
  Remove-Item Env:GIT_TRACE2_EVENT -ErrorAction SilentlyContinue
  Pop-Location
}
