# update-sermon.ps1
# 从周报PDF提取讲道信息，从YouTube获取直播链接，更新 sermons.html
#
# 使用方法:
#   .\update-sermon.ps1
#
# 依赖:
#   pip install pypdf2
#   pip install yt-dlp   (或: winget install yt-dlp)

$env:PYTHONIOENCODING = "utf-8"

$BulletinFolder = "G:\Shared drives\ChurchSharedFolder\Documents\Bulletin\2026\To publish"
$SermonsHtml    = "$PSScriptRoot\sermons.html"
$YouTubeChannel = "https://www.youtube.com/@calgarynewlifeevangelicalf5137"

# ─────────────────────────────────────────────────────────────
# 步骤 1：提取 PDF 讲道信息
# ─────────────────────────────────────────────────────────────
Write-Host "`n[1/3] 读取周报 PDF..." -ForegroundColor Cyan

$pyExtract = @'
import sys, os, re
sys.stdout.reconfigure(encoding='utf-8')
try:
    import PyPDF2 as pdf_lib
    def get_text(path):
        r = pdf_lib.PdfReader(path)
        return "\n".join(p.extract_text() or "" for p in r.pages)
except ImportError:
    try:
        from pypdf import PdfReader
        def get_text(path):
            r = PdfReader(path)
            return "\n".join(p.extract_text() or "" for p in r.pages)
    except ImportError:
        print("ERROR:请安装 pypdf2 或 pypdf: pip install pypdf2")
        sys.exit(1)

folder = os.environ.get('BULLETIN_FOLDER') or (sys.argv[1] if len(sys.argv) > 1 else '.')
pdfs = sorted([f for f in os.listdir(folder) if f.lower().endswith('.pdf')])

for fname in pdfs:
    path = os.path.join(folder, fname)
    text = get_text(path)
    # 匹配 "讲道 题目  讲员" 行（一行内，讲员以牧师/传道结尾）
    m = re.search(r'讲道\s+(.+?)\s{2,}(.+?(?:牧[　\s]*[师師]|传[　\s]*道))', text)
    if not m:
        # 宽松：讲道后跟换行，再一行是讲员
        m = re.search(r'讲道\s+(.+?)\s+([\S]+(?:牧[师師]|传道))', text)
    if not m:
        m = re.search(r'讲道[:：]?\s*\n?\s*(.+?)\n\s*(.+?(?:牧师|传道))', text)
    # 优先从文件名取日期（最可靠）
    dn = re.search(r'(202\d)[_\-\s]?(\d{2})[_\-\s]?(\d{2})', fname)
    if dn:
        date_str = f"{dn.group(1)}-{dn.group(2)}-{dn.group(3)}"
    else:
        date_m = re.search(r'(202[0-9])[年\-/](\d{1,2})[月\-/](\d{1,2})', text)
        if date_m:
            date_str = f"{date_m.group(1)}-{date_m.group(2).zfill(2)}-{date_m.group(3).zfill(2)}"
        else:
            date_str = "unknown"
    if m:
        title   = m.group(1).strip()
        speaker = m.group(2).strip()
        print(f"{date_str}|{title}|{speaker}")
    else:
        print(f"{date_str}|UNKNOWN|UNKNOWN")
'@

$env:BULLETIN_FOLDER = $BulletinFolder
$extracted = python -c $pyExtract
if ($LASTEXITCODE -ne 0) {
    Write-Host "PDF 提取失败，请检查 pypdf2 是否安装。" -ForegroundColor Red
    exit 1
}

Write-Host "从 PDF 提取的讲道信息：" -ForegroundColor Green
$extracted | ForEach-Object { Write-Host "  $_" }

# ─────────────────────────────────────────────────────────────
# 步骤 2：从 YouTube 频道获取最近视频
# ─────────────────────────────────────────────────────────────
Write-Host "`n[2/3] 获取 YouTube 最近视频..." -ForegroundColor Cyan

# 检查 yt-dlp（包括 pip 安装后不在 PATH 的情况）
$ytdlp = $null
$ytdlpCandidates = @(
    "yt-dlp",
    "$env:APPDATA\Python\Python314\Scripts\yt-dlp.exe",
    "$env:APPDATA\Python\Python313\Scripts\yt-dlp.exe",
    "$env:APPDATA\Python\Python312\Scripts\yt-dlp.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python314\Scripts\yt-dlp.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python313\Scripts\yt-dlp.exe"
)
foreach ($c in $ytdlpCandidates) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { $ytdlp = $c; break }
    if ($c -ne "yt-dlp" -and (Test-Path $c)) { $ytdlp = $c; break }
}
if (-not $ytdlp) {
    Write-Host "  未找到 yt-dlp，尝试 pip 安装..." -ForegroundColor Yellow
    pip install yt-dlp -q
    # 再次搜索
    foreach ($c in $ytdlpCandidates) {
        if (Get-Command $c -ErrorAction SilentlyContinue) { $ytdlp = $c; break }
        if ($c -ne "yt-dlp" -and (Test-Path $c)) { $ytdlp = $c; break }
    }
}
if ($ytdlp) { Write-Host "  使用 yt-dlp: $ytdlp" -ForegroundColor DarkGray }

# 获取频道最近视频，写入临时文件再读取（避免跨进程 stdout 捕获问题）
$ytTmp = [System.IO.Path]::GetTempFileName()
& $ytdlp --flat-playlist --playlist-end 50 --print "%(upload_date)s|%(id)s|%(title)s" $YouTubeChannel > $ytTmp
$ytJson = Get-Content $ytTmp -Encoding UTF8
Remove-Item $ytTmp -ErrorAction SilentlyContinue
if (-not $ytJson) {
    Write-Host "  yt-dlp 获取失败，请手动提供 YouTube 链接。" -ForegroundColor Yellow
    $ytJson = @()
}

Write-Host "YouTube 最近视频：" -ForegroundColor Green
$ytVideos = @{}
foreach ($line in $ytJson) {
    if ($line -notmatch '^[^|]+\|[^|]+\|') { continue }
    $parts = $line -split '\|', 3
    $uploadDate = $parts[0]
    $vid        = $parts[1]
    $ttl        = $parts[2]

    $ttl = $ttl.Trim()
    $dt = $null
    # 中文日期格式："2026年7月5日 ..." 或 "2026年07月05日 ..."
    if ($ttl -match '(202\d)[年\s](\d{1,2})[月\s](\d{1,2})[日\s]') {
        $dt = "$($Matches[1])-$($Matches[2].PadLeft(2,'0'))-$($Matches[3].PadLeft(2,'0'))"
    # 数字格式：YYYYMD 或 YYYYMMDD（如 2026705 或 20260705）
    } elseif ($ttl -match '^(202\d)(\d{1,2})(\d{2})$') {
        $dt = "$($Matches[1])-$($Matches[2].PadLeft(2,'0'))-$($Matches[3])"
    } elseif ($ttl -match '^(202\d)-(\d{1,2})-(\d{1,2})$') {
        $dt = "$($Matches[1])-$($Matches[2].PadLeft(2,'0'))-$($Matches[3].PadLeft(2,'0'))"
    } elseif ($uploadDate -match '^\d{8}$') {
        $dt = "$($uploadDate.Substring(0,4))-$($uploadDate.Substring(4,2))-$($uploadDate.Substring(6,2))"
    }

    if ($dt) {
        $ytVideos[$dt] = @{ id = $vid; title = $ttl }
        Write-Host "  $dt  $vid  $ttl"
    }
}

# ─────────────────────────────────────────────────────────────
# 步骤 3：匹配并插入 sermons.html
# ─────────────────────────────────────────────────────────────
Write-Host "`n[3/3] 更新 sermons.html..." -ForegroundColor Cyan

$html = Get-Content $SermonsHtml -Encoding UTF8 -Raw

# 读取已有日期，避免重复
$existingDates = [regex]::Matches($html, 'sermon-date">(\d{4}-\d{2}-\d{2})<') |
                 ForEach-Object { $_.Groups[1].Value }

$newRows = @()
$skipped = @()
$ytLinksAdded = 0

foreach ($line in $extracted) {
    $parts = $line -split '\|'
    if ($parts.Count -lt 3) { continue }
    $date, $title, $speaker = $parts[0], $parts[1], $parts[2]

    # 如果已存在但没有 YT 链接，尝试补上链接
    if ($existingDates -contains $date) {
        $yt = $ytVideos[$date]
        if ($yt) {
            $ytUrl = "https://www.youtube.com/watch?v=$($yt.id)"
            $oldRow = "<td class=`"sermon-date`">$date</td><td class=`"sermon-title`">$title</td>"
            $newRow = "<td class=`"sermon-date`">$date</td><td class=`"sermon-title`"><a href=`"$ytUrl`" target=`"_blank`" rel=`"noopener`">$title <span class=`"yt-badge`">YT</span></a></td>"
            if ($html -match [regex]::Escape($oldRow)) {
                $html = $html -replace [regex]::Escape($oldRow), $newRow
                $ytLinksAdded++
                Write-Host "  ✓ 已补充YT链接：$date  $title → $($yt.id)" -ForegroundColor Cyan
            } else {
                $skipped += $date
            }
        } else {
            $skipped += $date
        }
        continue
    }
    if ($title -eq "UNKNOWN") {
        Write-Host "  [$date] 无法提取讲道信息，请手动填写。" -ForegroundColor Yellow
        $newRows += "            <!-- TODO: $date 讲道信息未能自动提取，请手动填写 -->"
        $newRows += "            <tr><td class=`"sermon-date`">$date</td><td class=`"sermon-title`">（未提取）</td><td class=`"sermon-speaker`">（未提取）</td></tr>"
        continue
    }

    # 查找匹配的 YouTube 视频
    $yt = $ytVideos[$date]
    if ($yt) {
        $ytUrl = "https://www.youtube.com/watch?v=$($yt.id)"
        $row = "            <tr><td class=`"sermon-date`">$date</td><td class=`"sermon-title`"><a href=`"$ytUrl`" target=`"_blank`" rel=`"noopener`">$title <span class=`"yt-badge`">YT</span></a></td><td class=`"sermon-speaker`">$speaker</td></tr>"
        Write-Host "  ✓ $date  $title / $speaker  → YT $($yt.id)" -ForegroundColor Green
    } else {
        $row = "            <tr><td class=`"sermon-date`">$date</td><td class=`"sermon-title`">$title</td><td class=`"sermon-speaker`">$speaker</td></tr>"
        Write-Host "  ⚠ $date  $title / $speaker  → 未找到YouTube链接" -ForegroundColor Yellow
    }
    $newRows += $row
}

if ($skipped.Count -gt 0) {
    Write-Host "  已跳过（已存在）：$($skipped -join ', ')" -ForegroundColor DarkGray
}

if ($newRows.Count -eq 0 -and $ytLinksAdded -eq 0) {
    Write-Host "没有需要新增或更新的讲道记录。" -ForegroundColor Green
    exit 0
}

# 插入到 2026 表格的第一行之前（紧接 <tbody> 后）
$insertMarker = '<thead><tr><th>日期</th><th>题目</th><th>讲员</th></tr></thead>'
$tbodyMarker  = $insertMarker + "`n          <tbody>"

# 找到 2026 section 的 tbody，在第一个 <tr> 前插入
$insertBlock = $newRows -join "`n"
$pattern = '(<!-- 2026 视频 -->[\s\S]*?<tbody>\s*\n)'
$html = [regex]::Replace($html, $pattern, "`$1$insertBlock`n", [System.Text.RegularExpressions.RegexOptions]::Singleline)

# 更新讲数统计
$allRows2026 = [regex]::Matches($html, '(?s)<!-- 2026 视频 -->.*?</details>') | Select-Object -First 1
if ($allRows2026) {
    $count = ([regex]::Matches($allRows2026.Value, '<tr><td class="sermon-date">')).Count
    $html = $html -replace '2026年讲道视频（共\d+讲）', "2026年讲道视频（共${count}讲）"
}

Set-Content $SermonsHtml -Value $html -Encoding UTF8 -NoNewline
Write-Host "`n完成！新增 $($newRows.Count) 条记录到 sermons.html。" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────
# 步骤 4：自动 git commit & push
# ──────────────────────────────────────────────────────────���──
Write-Host "`n[4/4] Git commit & push..." -ForegroundColor Cyan

$commitDate = Get-Date -Format "yyyy-MM-dd"
$commitMsg  = "自动更新讲道集 $commitDate"

git -C $PSScriptRoot add sermons.html
git -C $PSScriptRoot commit -m $commitMsg
if ($LASTEXITCODE -eq 0) {
    git -C $PSScriptRoot push
    if ($LASTEXITCODE -eq 0) {
        Write-Host "已推送到 GitHub。`n" -ForegroundColor Green
    } else {
        Write-Host "推送失��，请手动运行 git push。`n" -ForegroundColor Yellow
    }
} else {
    Write-Host "没有变更需要提交（可能已是最新）。`n" -ForegroundColor DarkGray
}
