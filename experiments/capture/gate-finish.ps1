$ErrorActionPreference='Stop'
Set-Location (Join-Path $PSScriptRoot '../..')
$env:CAPTURE_PUBLIC_CHECK='0';$env:CAPTURE_REUSE='1';$env:MEDIA_FPS='15'
docker --context desktop-linux build -f experiments/capture/Dockerfile -t zvonok-browser-capture:2b1 . *> artifacts/final-lifecycle-image-build.txt
node experiments/capture/gate-lifecycle.mjs *> artifacts/final-lifecycle-campaign.txt
Get-Content artifacts/final-lifecycle-campaign.txt -Tail 3
docker --context desktop-linux compose -f compose.capture.yaml up -d --no-deps --force-recreate capture publisher
$env:GATE_RUN='latency-final15';$env:GATE_SECONDS='5';$env:GATE_ACTIONS='100'
node experiments/capture/gate-check.mjs *> artifacts/latency-final15.txt
Get-Content experiments/capture/security-check.mjs -Raw | docker --context desktop-linux compose -f compose.capture.yaml exec -T capture node24 --input-type=module *> artifacts/final-capture-security.txt
docker --context desktop-linux compose -f compose.capture.yaml exec -T capture node24 experiments/capture/network-check.mjs *> artifacts/final-capture-network.txt
docker --context desktop-linux compose -f compose.capture.yaml exec -T guard sh -c 'iptables -S OUTPUT; ip6tables -S OUTPUT' *> artifacts/final-capture-firewall.txt
foreach($attempt in 1..3){
 $env:GATE_CAMPAIGN='final-'+$attempt
 node experiments/capture/recovery-check.mjs *> ('artifacts/final-recovery-'+$attempt+'.txt')
}
pwsh -NoProfile -File scripts/acceptance.ps1 *> artifacts/final-api-capture.txt
$env:GATE_API='final-capture';node experiments/capture/gate-api.mjs *> artifacts/final-api-capture-timeline.txt
docker --context desktop-linux compose -f compose.capture.yaml stop capture publisher
pwsh -NoProfile -File scripts/acceptance.ps1 *> artifacts/final-api-alone.txt
docker --context desktop-linux compose exec -T worker node24 scripts/network-check.mjs *> artifacts/final-original-network.txt
docker --context desktop-linux compose exec -T worker node24 scripts/browser-check.mjs *> artifacts/final-original-browser.txt
pwsh -NoProfile -File scripts/lifecycle-check.ps1 *> artifacts/final-original-lifecycle.txt
docker --context desktop-linux compose -f compose.media.yaml start generator publisher
$env:MEDIA_RUN='final-2a';$env:MEDIA_SECONDS='65';node scripts/media-check.mjs *> artifacts/final-2a.txt
docker --context desktop-linux compose -f compose.media.yaml stop generator publisher
node experiments/capture/gate-summary.mjs *> artifacts/final-summary.txt
