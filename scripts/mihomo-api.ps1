# mihomo (Clash Verge Rev) 控制 API 辅助脚本 — 命名管道访问
# 用法:
#   .\mihomo-api.ps1 proxies              # 列出代理组与节点
#   .\mihomo-api.ps1 switch <组名> <节点名>  # 切换节点
#   .\mihomo-api.ps1 test <组名>           # 对组内候选节点测 Docker Hub 上传吞吐并选优
#
# 设计说明:
#   - external-controller 走命名管道 \\.\pipe\verge-mihomo（Windows mihomo v1.19+）
#   - 响应可能是 chunked 编码, 用字节级解析 + 手工解 chunk, 避免 ConvertFrom-Json 误判
#   - 测速: 对 registry-1.docker.io 做 POST upload session + PATCH 1MB, 测真实上传吞吐
#   - 凭据: 从 docker credential helper 读取, 用于换取 registry push token（不回显）

$pipeName = 'verge-mihomo'
$secret = 'set-your-secret'

function Invoke-MihomoApi($method, $path, $body = $null) {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(3000)
    $req = "$method $path HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer $secret`r`nConnection: close`r`n"
    if ($null -ne $body) {
        $req += "Content-Type: application/json`r`nContent-Length: $([Text.Encoding]::UTF8.GetByteCount($body))`r`n"
    }
    $req += "`r`n"
    if ($null -ne $body) { $req += $body }
    $reqBytes = [Text.Encoding]::UTF8.GetBytes($req)
    $pipe.Write($reqBytes, 0, $reqBytes.Length)
    $pipe.Flush()
    $ms = New-Object System.IO.MemoryStream
    $buf = New-Object byte[] 8192
    while (($n = $pipe.Read($buf, 0, 8192)) -gt 0) { $ms.Write($buf, 0, $n) }
    $pipe.Dispose()
    $raw = $ms.ToArray()
    $headerEnd = -1
    for ($i = 0; $i -lt $raw.Length - 3; $i++) {
        if ($raw[$i] -eq 13 -and $raw[$i + 1] -eq 10 -and $raw[$i + 2] -eq 13 -and $raw[$i + 3] -eq 10) { $headerEnd = $i; break }
    }
    if ($headerEnd -lt 0) { return $null }
    $headers = [Text.Encoding]::UTF8.GetString($raw, 0, $headerEnd)
    $bodyStart = $headerEnd + 4
    $bodyLen = $raw.Length - $bodyStart
    $isChunked = $headers -match '(?i)Transfer-Encoding:\s*chunked'
    if ($isChunked) {
        $out = New-Object System.Collections.Generic.List[byte]
        $pos = $bodyStart
        while ($pos -lt $raw.Length) {
            $nl = -1
            for ($i = $pos; $i -lt $raw.Length - 1; $i++) { if ($raw[$i] -eq 13 -and $raw[$i + 1] -eq 10) { $nl = $i; break } }
            if ($nl -lt 0) { break }
            $sizeHex = [Text.Encoding]::ASCII.GetString($raw, $pos, $nl - $pos)
            $size = [Convert]::ToInt32(($sizeHex -split ';')[0].Trim(), 16)
            if ($size -eq 0) { break }
            $dataStart = $nl + 2
            for ($j = 0; $j -lt $size; $j++) { $out.Add($raw[$dataStart + $j]) }
            $pos = $dataStart + $size + 2
        }
        return [Text.Encoding]::UTF8.GetString($out.ToArray())
    } else {
        return [Text.Encoding]::UTF8.GetString($raw, $bodyStart, $bodyLen)
    }
}

function Get-DockerHubToken {
    $cred = (echo "https://index.docker.io/v1/" | docker-credential-desktop get 2>$null)
    if ($LASTEXITCODE -ne 0) { $cred = (echo "https://index.docker.io/v1/" | docker-credential-wincred get 2>$null) }
    $j = $cred | ConvertFrom-Json
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($j.Username):$($j.Secret)"))
    $tok = (curl.exe -sS --max-time 15 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:jinnnyang/omniroute:pull,push" -H "Authorization: Basic $basic" | ConvertFrom-Json).token
    return $tok
}

function Test-DockerHubUploadSpeed {
    # 返回 KB/s；失败返回 -1
    $tok = Get-DockerHubToken
    $hdrs = curl.exe -sS -D - -o NUL --max-time 20 -x http://127.0.0.1:7897 -X POST "https://registry-1.docker.io/v2/jinnnyang/omniroute/blobs/uploads/" -H "Authorization: Bearer $tok" 2>&1
    $loc = ($hdrs | Select-String -Pattern '(?i)^location:' | Select-Object -First 1).ToString().Substring(10).Trim()
    if (-not $loc) { return -1 }
    $tmp = "$env:TEMP\mihomo-bench-chunk.bin"
    $bytes = New-Object byte[] (1048576)
    (New-Object Random).NextBytes($bytes)
    [IO.File]::WriteAllBytes($tmp, $bytes)
    $res = curl.exe -sS -o NUL -w "%{http_code} %{time_total}" --max-time 60 -x http://127.0.0.1:7897 -X PATCH $loc -H "Authorization: Bearer $tok" -H "Content-Type: application/octet-stream" -H "Content-Range: 0-1048575" --data-binary "@$tmp" 2>&1
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    $parts = $res -split ' '
    if ($parts[0] -ne '202' -or $parts.Count -lt 2) { return -1 }
    $sec = [double]$parts[1]
    return [Math]::Round(1048576 / 1024 / $sec, 0)  # KB/s
}

$mode = $args[0]
switch ($mode) {
    'proxies' {
        $p = (Invoke-MihomoApi 'GET' '/proxies') | ConvertFrom-Json
        $p.proxies.PSObject.Properties | Where-Object { $_.Value.type -in @('Selector', 'URLTest', 'Fallback') } | ForEach-Object {
            $g = $_.Value
            "$($_.Name) | type=$($g.type) | now=$($g.now) | nodes=$($g.all.Count)"
        }
    }
    'list' {
        $group = $args[1]
        $p = (Invoke-MihomoApi 'GET' '/proxies') | ConvertFrom-Json
        $g = $p.proxies.$group
        if (-not $g) { "GROUP NOT FOUND: $group"; exit 1 }
        "group=$group now=$($g.now)"
        $g.all | ForEach-Object { "  $_" }
    }
    'switch' {
        $group = $args[1]; $node = $args[2]
        $body = "{`"name`":`"$node`"}"
        $r = Invoke-MihomoApi 'PUT' "/proxies/$([Uri]::EscapeDataString($group))" $body
        "switch -> $node (in $group): $($r.Substring(0, [Math]::Min(40, $r.Length)))"
    }
    'test' {
        $group = $args[1]
        $filter = $args[2]
        $p = (Invoke-MihomoApi 'GET' '/proxies') | ConvertFrom-Json
        $g = $p.proxies.$group
        if (-not $g) { "GROUP NOT FOUND: $group"; exit 1 }
        $candidates = @($g.all | Where-Object { $_ -ne 'DIRECT' -and $_ -ne 'REJECT' })
        if ($filter) { $candidates = @($candidates | Where-Object { $_ -match $filter }) }
        "testing $($candidates.Count) nodes in '$group' (filter=$filter)..."
        $results = @()
        foreach ($node in $candidates) {
            Invoke-MihomoApi 'PUT' "/proxies/$([Uri]::EscapeDataString($group))" "{`"name`":`"$node`"}" | Out-Null
            Start-Sleep -Milliseconds 800
            $kb = Test-DockerHubUploadSpeed
            $r = [PSCustomObject]@{ node = $node; kbPerSec = $kb }
            $results += $r
            "{0,-40} {1,8} KB/s" -f $node, $kb
        }
        # 恢复原节点
        Invoke-MihomoApi 'PUT' "/proxies/$([Uri]::EscapeDataString($group))" "{`"name`":`"$($g.now)`"}" | Out-Null
        "--- best: $($results | Sort-Object kbPerSec -Descending | Select-Object -First 1 | ForEach-Object { "$($_.node) = $($_.kbPerSec) KB/s" })"
    }
    default { "usage: proxies | list <group> | switch <group> <node> | test <group> [filter]" }
}
