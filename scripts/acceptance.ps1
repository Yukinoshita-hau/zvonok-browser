$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot)
$tokenLine=Get-Content .env | Where-Object { $_ -like 'DEV_TOKEN=*' }
$headers=@{Authorization='Bearer '+$tokenLine.Substring(10)}
$base='http://127.0.0.1:47831/api'
$rows=[Collections.Generic.List[object]]::new()
function Check($name,[scriptblock]$test) { try { & $test; $rows.Add(@{name=$name;result='PASS'}) } catch { $rows.Add(@{name=$name;result='FAIL';detail=$_.Exception.Message}) } }
function Call($path,$method='GET',$body=$null) { $args=@{Uri=$base+$path;Method=$method;Headers=$headers}; if($null -ne $body){$args.ContentType='application/json';$args.Body=ConvertTo-Json -Compress $body}; Invoke-RestMethod @args }
Check 'health' { if((Call '/health').status -ne 'ok'){throw 'health'} }
Check 'ready' { $ok=$false; for($i=0;$i -lt 20;$i++){try{if((Call '/ready').status -eq 'ready'){$ok=$true;break}}catch{};Start-Sleep -Milliseconds 500};if(-not $ok){throw 'Worker not ready'} }
Check 'unauthorized rejected' { $r=Invoke-WebRequest "$base/sessions" -Method POST -ContentType application/json -Body '{}' -SkipHttpErrorCheck; if($r.StatusCode -ne 401){throw "HTTP $($r.StatusCode)"} }
$script:session=$null
try {
 Check 'create Chromium' { $script:session=Call '/sessions' POST @{}; if($session.status -ne 'active'){throw 'not active'} }
 if($session){
 $id=$session.sessionId
 Check 'one session limit' { $r=Invoke-WebRequest "$base/sessions" -Headers $headers -Method POST -ContentType application/json -Body '{}' -SkipHttpErrorCheck; if($r.StatusCode -ne 409){throw "HTTP $($r.StatusCode)"} }
 Check 'navigate example' { $s=Call "/sessions/$id/navigate" POST @{url='https://example.com/'}; if($s.currentUrl -notlike 'https://example.com/*'){throw 'URL'} }
 Check 'navigate form' { Call "/sessions/$id/navigate" POST @{url='https://www.selenium.dev/selenium/web/web-form.html'} | Out-Null }
 Check 'back' { $s=Call "/sessions/$id/back" POST @{}; if($s.currentUrl -notlike 'https://example.com/*'){throw 'history'} }
 Check 'forward' { $s=Call "/sessions/$id/forward" POST @{}; if($s.currentUrl -notlike '*web-form.html'){throw 'history'} }
 Check 'reload' { Call "/sessions/$id/reload" POST @{} | Out-Null }
 Check 'click keyboard scroll accepted' { foreach($action in @(@{type='mouseClick';x=150;y=135;button='left'},@{type='text';text='Slice one'},@{type='wheel';x=600;y=600;deltaX=0;deltaY=300})){Call "/sessions/$id/input" POST $action | Out-Null} }
 Check 'diagnostic PNG' { New-Item -ItemType Directory -Force artifacts | Out-Null; Invoke-WebRequest "$base/sessions/$id/frame" -Headers $headers -OutFile artifacts/frame.png; if((Get-Item artifacts/frame.png).Length -lt 1000){throw 'empty frame'} }
 Check 'invalid URL rejected' { $r=Invoke-WebRequest "$base/sessions/$id/navigate" -Headers $headers -Method POST -ContentType application/json -Body '{"url":"http://169.254.169.254/"}' -SkipHttpErrorCheck; if($r.StatusCode -ne 400){throw "HTTP $($r.StatusCode)"} }
 Check 'arbitrary command rejected' { $r=Invoke-WebRequest "$base/sessions/$id/input" -Headers $headers -Method POST -ContentType application/json -Body '{"type":"eval","code":"1"}' -SkipHttpErrorCheck; if($r.StatusCode -ne 400){throw "HTTP $($r.StatusCode)"} }
 }
} finally { if($session){Check 'delete' { Call ('/sessions/'+$session.sessionId) DELETE | Out-Null }} }
$rows | ForEach-Object {[pscustomobject]$_} | Select-Object name,result,detail | Format-Table -AutoSize -Wrap
if($rows.Where({$_.result -eq 'FAIL'}).Count){exit 1}

