$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)
$taskOut = "artifacts/slice4-regression-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
New-Item -ItemType Directory -Force $taskOut | Out-Null
$taskRows = [Collections.Generic.List[object]]::new()
function RunCheck($name, [scriptblock]$command) {
  & $command *> "$taskOut/$name.log"
  $taskRows.Add(@{name=$name;status=$(if($LASTEXITCODE -eq 0){'PASS'}else{'FAIL'});exit=$LASTEXITCODE})
  $taskRows | Select-Object -Last 1 | ForEach-Object {[pscustomobject]$_} | Format-Table
  $taskRows | ConvertTo-Json -Depth 5 | Set-Content "$taskOut/results.json"
}
$env:BROWSER_FIXTURE='1'
try {
  # Legacy DEV fixtures run only after Core campaigns ended. Worker stays in its guarded network.
  & docker --context desktop-linux compose -f compose.session.yaml up -d --no-build api worker broker
  if($LASTEXITCODE){throw 'Legacy session startup failed'}
  & docker --context desktop-linux compose -f compose.yaml up -d --no-build
  if($LASTEXITCODE){throw 'Slice 0-1 startup failed'}
  RunCheck 'slice0-1-and-network' { node session/regression.mjs }
  RunCheck 'session-security' { node session/security.mjs }
  RunCheck 'slice2b2' { node session/e2e.mjs }
  RunCheck 'slice3-shared' { node session/shared-e2e.mjs }
  RunCheck 'slice3-release' { node session/shared-release.mjs }
  RunCheck 'session-reliability' { node session/reliability.mjs }
  RunCheck 'session-lifecycle' { node session/lifecycle.mjs }
  & docker --context desktop-linux compose -f compose.yaml stop
  & docker --context desktop-linux compose -f compose.media.yaml up -d --no-build
  if($LASTEXITCODE){throw 'Slice 2A startup failed'}
  $env:MEDIA_RUN="slice4-regression-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  RunCheck 'slice2a' { node scripts/media-check.mjs }
} finally {
  & docker --context desktop-linux compose -f compose.yaml stop
  & docker --context desktop-linux compose -f compose.media.yaml stop
  Remove-Item Env:BROWSER_FIXTURE -ErrorAction SilentlyContinue
  $env:BROWSER_INTEGRATION_KEY=((Get-Content .env.integration.local -Raw).Trim() -split '=',2)[1]
  & docker --context desktop-linux compose -f compose.session.yaml -f compose.integration.yaml up -d --no-build api worker broker
  Write-Output "Evidence: $taskOut"
}
if($taskRows.Where({$_.status -ne 'PASS'}).Count){exit 1}
