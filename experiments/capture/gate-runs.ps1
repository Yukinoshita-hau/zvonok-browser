$ErrorActionPreference='Stop'
Set-Location (Join-Path $PSScriptRoot '../..')
$env:CAPTURE_PUBLIC_CHECK='0'
foreach($profile in @(@{name='final15-1';fps=15;reuse=1},@{name='final15-2';fps=15;reuse=1},@{name='final15-3';fps=15;reuse=1},@{name='final30-1';fps=30;reuse=1},@{name='final30-2';fps=30;reuse=1})){
 $env:MEDIA_FPS=[string]$profile.fps;$env:CAPTURE_REUSE=[string]$profile.reuse;$env:GATE_RUN=$profile.name;$env:GATE_SECONDS='95'
 docker --context desktop-linux compose -f compose.capture.yaml stop capture publisher
 docker --context desktop-linux compose -f compose.capture.yaml up -d --no-deps --force-recreate capture publisher
 node experiments/capture/gate-check.mjs *> ('artifacts/gate-'+$profile.name+'.txt')
 Get-Content ('artifacts/gate-'+$profile.name+'.txt') -Tail 2
}
