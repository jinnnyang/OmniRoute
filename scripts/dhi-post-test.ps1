# dhi-post-test.ps1 — 内联完整测试 dhi 凭据 → token → POST upload session
$repo = 'jinnnyang/omniroute'
$cred = (echo "https://dhi.io" | docker-credential-desktop get 2>$null)
Write-Host "dhi get: exit=$LASTEXITCODE len=$($cred.Length)"
$j = $cred | ConvertFrom-Json
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($j.Username):$($j.Secret)"))
$resp = curl.exe -sS --max-time 15 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull,push" -H "Authorization: Basic $basic" 2>&1
if ($resp -match '"token"') {
    $tok = ($resp | ConvertFrom-Json).token
    Write-Host "token len=$($tok.Length)"
    $p = $tok.Split('.')[1]
    $p = $p.Replace('-', '+').Replace('_', '/')
    while ($p.Length % 4) { $p += '=' }
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
    Write-Host "access: $($payload.access | ConvertTo-Json -Compress)"
    Write-Host "aud: $($payload.aud)"
    # POST via proxy
    $hdrs = curl.exe -sS -D - -o NUL --max-time 30 -x http://127.0.0.1:7897 -X POST "https://registry-1.docker.io/v2/$repo/blobs/uploads/" -H "Authorization: Bearer $tok" 2>&1
    $loc = $hdrs | Select-String -Pattern '(?i)^location:' | Select-Object -First 1
    if ($loc) { Write-Host "POST OK locLen=$($loc.ToString().Substring(10).Trim().Length)" }
    else { Write-Host "POST FAILED:"; $hdrs | Select-Object -First 8 | ForEach-Object { Write-Host "  $_" } }
} else {
    Write-Host "TOKEN REQ FAILED: $($resp.Substring(0, [Math]::Min(150, $resp.Length)))"
}
