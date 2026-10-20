# Local media environment only. Never reads or changes Core Zvonok credentials.
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot)
if(!(Test-Path media/livekit.local.yaml)){
 $key=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
 (Get-Content media/livekit.example.yaml -Raw).Replace('PLACEHOLDER',$key)|Set-Content media/livekit.local.yaml
}
docker --context desktop-linux compose -f compose.media.yaml up -d --build
if($LASTEXITCODE){exit $LASTEXITCODE}
Write-Output 'Viewer: http://127.0.0.1:47832 (existing .env DEV_TOKEN)'
