$ErrorActionPreference = 'Continue'
$prevSha = ''
for ($i = 1; $i -le 12; $i++) {
    Write-Output "=== push round $i $(Get-Date -Format 'HH:mm:ss') ==="
    $out = docker push jinnnyang/omniroute:3.8.56 2>&1
    $out | Select-Object -Last 1
    if ($LASTEXITCODE -eq 0) {
        Write-Output "PUSH COMPLETE on round $i"
        break
    }
    $m = $out | Select-String -Pattern 'digest=sha256%3A([a-f0-9]{8})' | Select-Object -First 1
    $failSha = ''
    if ($m) { $failSha = $m.Matches[0].Groups[1].Value }
    if ($failSha -and $failSha -ne $prevSha) {
        Write-Output "round ${i}: stuck on NEW layer ${failSha} (progress!)"
    } elseif ($failSha) {
        Write-Output "round ${i}: SAME layer ${failSha} again"
    }
    $prevSha = $failSha
    Start-Sleep -Seconds 30
}
Write-Output "FINAL_EXIT=$LASTEXITCODE"
