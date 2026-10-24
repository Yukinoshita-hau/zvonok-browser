# Local DEV_TOKEN PoC. Reuses the installed Slice0–1/2A/2B.1 baseline images.
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot)
if(!(Test-Path session/livekit.local.yaml)){
 $sessionKey=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
 $sessionConfig=(Get-Content media/livekit.example.yaml -Raw).Replace('PLACEHOLDER',$sessionKey).Replace('47834','48034').Replace('47835','48035')
 if($sessionConfig.Contains('PLACEHOLDER') -or $sessionKey.Length -ne 64){throw 'Invalid local media configuration'}
 $sessionConfig | Set-Content session/livekit.local.yaml
}
docker --context desktop-linux compose -f compose.session.yaml up -d --build
if($LASTEXITCODE){exit $LASTEXITCODE}
Write-Output 'Browser: http://127.0.0.1:48031 (existing .env DEV_TOKEN, local-owner only)'
