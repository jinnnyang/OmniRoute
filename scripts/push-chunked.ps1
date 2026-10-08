# push-chunked.ps1 — 绕过 docker push 单次大 PUT 超时的分块推送脚本
#
# 原理:
#   docker push 对每个 blob 做单次大 PUT, 在低带宽代理下必然超过 registry 的
#   ResponseHeaderTimeout, 且每次从 Offset:0 重传。本脚本改用 Registry v2 的
#   PATCH 分块上传: 每块 1MB, 单块失败只重试该块, 且每次 PATCH 响应都会返回
#   新的 upload URL (刷新 session 过期), 因此任何带宽下都能传完任意大小的层。
#
# 流程:
#   docker save -> 解析 manifest.json -> 逐层: HEAD 已存在则跳过 -> POST 建 session
#   -> PATCH 分块(失败重试) -> PUT 完成 -> 上传 config -> POST manifest -> 校验
#
# 用法:  .\push-chunked.ps1 -Image jinnnyang/omniroute:3.8.57 [-ChunkMB 1] [-Proxy http://127.0.0.1:7897]
# 断点续传: 重启脚本即可, 已上传的层会被 HEAD 检查跳过。
# 注意: 不用 Get-FileHash（在 2>$null 管道/agent 环境下对存在文件偶发返回 null），
#       改用 .NET 流式 SHA256（FileShare.ReadWrite 绕开文件短暂锁定）。

param(
    [string]$Image = 'jinnnyang/omniroute:3.8.57',
    [int]$ChunkMB = 1,
    [string]$Proxy = 'http://127.0.0.1:7897',
    [switch]$NoProxy,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$repo = 'jinnnyang/omniroute'
$workDir = "$env:TEMP\omniroute-chunked-push"
$proxyArgs = @()
if (-not $NoProxy) { $proxyArgs = @('-x', $Proxy) }

# ---------- 工具函数 ----------
function Get-Sha256Hex([string]$path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $fs = $null
    try {
        $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $hash = $sha.ComputeHash($fs)
        return ([BitConverter]::ToString($hash) -replace '-', '').ToLower()
    } finally {
        if ($null -ne $fs) { $fs.Dispose() }
        $sha.Dispose()
    }
}

# 缓存式 token: 300 秒有效, 超过 240 秒自动刷新; 获取失败重试 3 次
$script:tok = $null
$script:tokTime = [DateTime]::MinValue
function Get-Token {
    if ($null -ne $script:tok -and ((Get-Date) - $script:tokTime).TotalSeconds -lt 240) { return $script:tok }
    for ($i = 1; $i -le 6; $i++) {
        $cred = (echo "https://dhi.io" | docker-credential-desktop get 2>$null)

        if ($LASTEXITCODE -ne 0 -or -not $cred) { $cred = (echo "https://index.docker.io/v1/" | docker-credential-desktop get 2>$null) }
        if ($LASTEXITCODE -ne 0) { $cred = (echo "https://index.docker.io/v1/" | docker-credential-wincred get 2>$null) }
        $j = $cred | ConvertFrom-Json
        $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($j.Username):$($j.Secret)"))
        $resp = curl.exe -sS --max-time 15 @proxyArgs "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$($repo):pull,push" -H "Authorization: Basic $basic" 2>$null
        $tok = ($resp | ConvertFrom-Json).token
        if ($tok) {
            $script:tok = $tok
            $script:tokTime = Get-Date
            return $tok
        }
        Write-Host "  token retry $i/3 (empty token from auth.docker.io)"
        Start-Sleep -Seconds 2
    }
    throw "token acquisition failed after 6 tries"
}

function Head-Blob([string]$digest) {
    for ($h = 1; $h -le 3; $h++) {
        $tok = Get-Token
        $code = curl.exe -sS -L -o NUL -w "%{http_code}" --max-time 30 @proxyArgs "https://registry-1.docker.io/v2/$repo/blobs/$digest" -H "Authorization: Bearer $tok" 2>$null
        if ($code) { return $code }
        Start-Sleep -Seconds 5
    }
    return $code
}

function Upload-Blob([string]$layerFile, [string]$digest, [int]$chunkSize) {
    $size = [System.IO.FileInfo]::new($layerFile).Length
    $tok = Get-Token

    $hdrs = curl.exe -sS -D - -o NUL --max-time 30 @proxyArgs -X POST "https://registry-1.docker.io/v2/$repo/blobs/uploads/" -H "Authorization: Bearer $tok" 2>$null
    $locLine = $hdrs | Select-String -Pattern '(?i)^location:' | Select-Object -First 1
    if (-not $locLine) {
        if ($hdrs -match '401') { $script:tokTime = [DateTime]::MinValue; $tok = Get-Token }
        throw "POST upload session failed: $($hdrs -join '|')"
    }
    $loc = $locLine.ToString().Substring(10).Trim()

    $fs = [System.IO.File]::OpenRead($layerFile)
    try {
        $offset = [long]0
        $buf = New-Object byte[] $chunkSize
        $block = 0
        while ($offset -lt $size) {
            $read = $fs.Read($buf, 0, $buf.Length)
            if ($read -le 0) { throw "file read error at offset $offset" }
            $end = $offset + $read - 1
            $part = New-Object byte[] $read
            [Array]::Copy($buf, $part, $read)
            $tmp = "$env:TEMP\omniroute-chunk-part.bin"
            [System.IO.File]::WriteAllBytes($tmp, $part)

            $ok = $false
            for ($try = 1; $try -le 8; $try++) {
                $tok = Get-Token
                $hdrs2 = curl.exe -sS -D - -o NUL --max-time 90 @proxyArgs -X PATCH $loc -H "Authorization: Bearer $tok" -H "Content-Type: application/octet-stream" -H "Content-Range: $offset-$end" --data-binary "@$tmp" 2>$null
                $loc2Line = $hdrs2 | Select-String -Pattern '(?i)^location:' | Select-Object -First 1
                if ($loc2Line) {
                    $loc = $loc2Line.ToString().Substring(10).Trim()
                    $ok = $true
                    break
                }
                if ($hdrs2 -match '401') { $script:tokTime = [DateTime]::MinValue }  # token 过期, 强制刷新
                Start-Sleep -Seconds (2 * $try)
            }
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            if (-not $ok) { throw "chunk at offset $offset failed after 8 tries" }
            $offset = $end + 1
            $block++
            $pct = [Math]::Round(100.0 * $offset / $size, 1)
            Write-Host "  chunk $block ($([Math]::Round($offset/1MB,1))MB/$([Math]::Round($size/1MB,1))MB, ${pct}%)"
        }
    } finally {
        $fs.Dispose()
    }

    $tok = Get-Token
    $fin = curl.exe -sS -o NUL -w "%{http_code}" --max-time 30 @proxyArgs -X PUT "$loc&digest=$digest" -H "Authorization: Bearer $tok" 2>$null
    if ($fin -ne '201') { throw "PUT finalize failed: $fin" }
    Write-Host "  blob $($digest.Substring(7,12)) UPLOADED"
}

# ---------- 2. docker save + 解析 ----------
if (-not (Test-Path "$workDir\layers.json")) {
    New-Item -ItemType Directory -Force -Path $workDir | Out-Null
    Write-Host "docker save $Image ..."
    docker save $Image -o "$workDir\image.tar" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker save failed" }
    Write-Host "extracting tar ..."
    tar -xf "$workDir\image.tar" -C "$workDir" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tar extract failed" }
    Write-Host "done."
    [System.IO.File]::WriteAllText("$workDir\layers.json", "cached $(Get-Date -Format o)", (New-Object Text.UTF8Encoding $false))
}

$manifest = Get-Content "$workDir\manifest.json" -Raw | ConvertFrom-Json
$cfg = $manifest[0]
$fsLayers = @()
foreach ($l in $cfg.Layers) {
    $digest = Get-Sha256Hex "$workDir\$l"
    $fname = ($l -split '/')[-1]
    if ($fname -ne $digest) { throw "LAYER SELF-CHECK FAILED: $l (fnameLen=$($fname.Length) digestLen=$($digest.Length))" }
    $fsLayers += [PSCustomObject]@{ File = $l; Digest = "sha256:$digest"; Size = [System.IO.FileInfo]::new("$workDir\$l").Length }
}
$configFile = $cfg.Config
$configPath = "$workDir\$configFile"
$configDigest = "sha256:$(Get-Sha256Hex $configPath)"
$configSize = [System.IO.FileInfo]::new($configPath).Length
$cfgFname = ($configFile -split '/')[-1]
if ($cfgFname -ne $configDigest.Substring(7)) { throw "CONFIG SELF-CHECK FAILED: $configFile" }
Write-Host "layer self-check OK ($($fsLayers.Count) layers, all filename==sha256)"

# 构造 registry v2 manifest（docker save 的 manifest.json 是保存格式, 不可直接 PUT）
# 注意: 用 PSCustomObject 而非 hashtable, 规避 PS 5.1 ConvertTo-Json 对 hashtable 数组的序列化 bug
$layerObjs = @()
foreach ($fl in $fsLayers) {
    $layerObjs += [PSCustomObject]@{ mediaType = 'application/vnd.docker.image.rootfs.diff.tar.gzip'; size = $fl.Size; digest = $fl.Digest }
}
$regManifest = @{
    schemaVersion = 2
    mediaType = 'application/vnd.docker.distribution.manifest.v2+json'
    config = @{
        mediaType = 'application/vnd.docker.container.image.v1+json'
        size = $configSize
        digest = $configDigest
    }
    layers = $layerObjs
}
$regManifestJson = $regManifest | ConvertTo-Json -Depth 6
$regManifestPath = "$workDir\registry-manifest.json"
[System.IO.File]::WriteAllText($regManifestPath, $regManifestJson, (New-Object Text.UTF8Encoding $false))

Write-Host "== layers =="
$fsLayers | ForEach-Object { "  $($_.Size.ToString().PadLeft(10)) $($_.Digest.Substring(7,12))  $($_.File)" }
Write-Host "config: $configDigest ($configFile)"

# ---------- 3. 上传 ----------
if ($DryRun) { Write-Host "== DRY RUN: parse+verify OK, upload skipped =="; exit 0 }
$chunkSize = $ChunkMB * 1MB

foreach ($layer in $fsLayers) {
    $code = Head-Blob $layer.Digest
    if ($code -eq '200') { Write-Host "SKIP (exists): $($layer.Digest.Substring(7,12))"; continue }
    Write-Host "UPLOAD: $($layer.Digest.Substring(7,12)) ($([Math]::Round($layer.Size/1MB,1))MB)"
    Upload-Blob "$workDir\$($layer.File)" $layer.Digest $chunkSize
}

$code = Head-Blob $configDigest
if ($code -ne '200') {
    Write-Host "UPLOAD config $configDigest"
    Upload-Blob "$workDir\$configFile" $configDigest $chunkSize
}

# ---------- 4. manifest ----------
$tag = ($Image -split ':')[1]
$mResp = curl.exe -sS -o NUL -w "%{http_code}" --max-time 60 @proxyArgs -X PUT "https://registry-1.docker.io/v2/$repo/manifests/$tag" -H "Authorization: Bearer $(Get-Token)" -H "Content-Type: application/vnd.docker.distribution.manifest.v2+json" --data-binary "@$regManifestPath" 2>$null
if ($mResp -ne '201') { throw "manifest PUT failed: $mResp" }
Write-Host "manifest ${tag} PUT 201"

# ---------- 5. 校验 ----------
$tok = Get-Token
$check = curl.exe -sS -o NUL -w "%{http_code}" --max-time 30 @proxyArgs -X HEAD "https://registry-1.docker.io/v2/$repo/manifests/$tag" -H "Authorization: Bearer $(Get-Token)" -H "Accept: application/vnd.docker.distribution.manifest.v2+json" 2>$null
if ($check -eq '200') { Write-Host "VERIFY OK: ${repo}:${tag} reachable" } else { Write-Host "WARN: verify returned $check" }
Write-Host "DONE."
