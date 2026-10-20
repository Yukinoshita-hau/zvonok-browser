param([string]$Name='720p15',[int]$Samples=10)
$ErrorActionPreference='Stop'
$rows=@()
for($i=0;$i -lt $Samples;$i++){
 $ids=docker --context desktop-linux compose -f compose.media.yaml ps -q
 $stats=docker --context desktop-linux stats --no-stream --format '{{json .}}' $ids
 if($LASTEXITCODE){throw 'docker stats failed'}
 $rows+=@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();containers=@($stats | ForEach-Object{$_|ConvertFrom-Json})}
 Start-Sleep -Seconds 3
}
$rows|ConvertTo-Json -Depth 8|Set-Content "artifacts/media-resources-$Name.json"
$top=foreach($id in $ids){$id;docker --context desktop-linux top $id -eo pid,ppid,nlwp,rss,comm}
$top|Set-Content "artifacts/media-processes-$Name.txt"
docker --context desktop-linux compose -f compose.media.yaml logs --no-log-prefix --no-color publisher generator | Where-Object {$_ -match '^\{"kind"'} | Set-Content "artifacts/media-source-$Name.jsonl"
Write-Output "Saved resources, processes and source metrics: $Name"
