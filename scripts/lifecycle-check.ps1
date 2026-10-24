$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot)
$tokenLine=Get-Content .env | Where-Object { $_ -like 'DEV_TOKEN=*' }
$headers=@{Authorization='Bearer '+$tokenLine.Substring(10)}
$base='http://127.0.0.1:47831/api'
function Call($path,$method='GET',$body=$null) { $args=@{Uri=$base+$path;Method=$method;Headers=$headers}; if($null -ne $body){$args.ContentType='application/json';$args.Body=ConvertTo-Json -Compress $body}; Invoke-RestMethod @args }
function Ready {for($i=0;$i -lt 20;$i++){try{if((Call '/ready').status -eq 'ready'){return}}catch{};Start-Sleep -Milliseconds 500};throw 'Worker not ready'}
function NoChrome { $p=docker compose -f compose.poc.yaml exec -T worker sh -c 'ps -eo comm | grep -E "chrome|chromium" || true';if($p){throw 'Chromium processes remain'} }
New-Item -ItemType Directory -Force artifacts | Out-Null
$override=Join-Path (Get-Location) 'artifacts/ttl.compose.yaml'
@'
services:
  worker:
    environment:
      IDLE_MS: '2000'
      TTL_MS: '5000'
'@ | Set-Content -Encoding utf8 $override
try {
 docker compose -f compose.poc.yaml -f $override up -d --no-deps --no-build worker
 if($LASTEXITCODE){throw 'TTL worker startup failed'}
 Ready
 $s=Call '/sessions' POST @{}
 Start-Sleep -Seconds 3
 if((Call ('/sessions/'+$s.sessionId)).status -ne 'expired'){throw 'Idle expiry failed'}
 NoChrome
 Write-Output 'PASS idle timeout and cleanup (2 seconds test override)'
 $s=Call '/sessions' POST @{}
 for($i=0;$i -lt 7;$i++) { Start-Sleep -Milliseconds 800;try {Call ('/sessions/'+$s.sessionId+'/input') POST @{type='mouseMove';x=10;y=10} | Out-Null}catch{} }
 if((Call ('/sessions/'+$s.sessionId)).status -ne 'expired'){throw 'Absolute TTL failed'}
 NoChrome
 Write-Output 'PASS absolute TTL despite activity (5 seconds test override)'
} finally {
 docker compose -f compose.poc.yaml up -d --no-deps --no-build worker
 Ready
}
$s=Call '/sessions' POST @{}
Get-Content scripts/crash-renderer.mjs -Raw | docker compose -f compose.poc.yaml exec -T worker node24 --input-type=module
if($LASTEXITCODE){throw 'Renderer crash injection failed'}
Start-Sleep -Seconds 1
if((Call ('/sessions/'+$s.sessionId)).status -ne 'crashed'){throw 'Page crash not detected'}
NoChrome
Write-Output 'PASS real renderer crash and cleanup'
$s=Call '/sessions' POST @{}
docker compose -f compose.poc.yaml stop -t 15 worker
if($LASTEXITCODE){throw 'Worker shutdown failed'}
$workerId=docker compose -f compose.poc.yaml ps -a -q worker
$state=docker inspect $workerId --format '{{.State.Status}} {{.State.ExitCode}}'
if($state.Trim() -ne 'exited 0'){throw "Shutdown result: $state"}
docker compose -f compose.poc.yaml up -d --no-deps --no-build worker
Ready
Write-Output 'PASS graceful worker shutdown while browser active; restarted clean'

