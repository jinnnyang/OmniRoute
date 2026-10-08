# verify-token.ps1 — 复现 Get-Token 逻辑并打印 token 权限（诊断用）
$ErrorActionPreference = 'Continue'
$repo = 'jinnnyang/omniroute'

$cred = (echo "https://dhi.io" | docker-credential-desktop get 2>$null)
Write-Host "dhi get: exit=$LASTEXITCODE len=$($cred.Length) raw=$cred"
if ($LASTEXITCODE -ne 0 -or -not $cred) {
    Write-Host "FALLBACK -> index.docker.io/v1/"
    $cred = (echo "https://index.docker.io/v1/" | docker-credential-desktop get 2>$null)
    Write-Host "fallback get: exit=$LASTEXITCODE len=$($cred.Length)"
}
$j = $cred | ConvertFrom-Json
Write-Host "user=$($j.Username) secretPrefix=$($j.Secret.Substring(0, [Math]::Min(10, $j.Secret.Length)))"
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($j.Username):$($j.Secret)"))
$resp = curl.exe -sS --max-time 15 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull,push" -H "Authorization: Basic $basic" 2>&1
if ($resp -match '"token"') {
    $tok = ($resp | ConvertFrom-Json).token
    Write-Host "tokenLen=$($tok.Length)"
    $p = $tok.Split('.')[1]
    $p = $p.Replace('-', '+').Replace('_', '/')
    while ($p.Length % 4) { $p += '=' }
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
    Write-Host "ACCESS: $($payload.access | ConvertTo-Json -Compress)"
    Write-Host "EXP: $($payload.exp)"
} else {
    Write-Host "TOKEN REQ FAILED: $($resp.Substring(0, [Math]::Min(200, $resp.Length)))"
}
