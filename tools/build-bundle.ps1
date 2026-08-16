<#
    Сборка автономного комплекта для компьютера без интернета.

    Складывает в одну папку программу, зависимости и портативный node.exe.
    На целевой машине не нужен ни Node.js, ни npm, ни компилятор, ни права
    администратора — только Windows 10+ x64.

    Запуск из папки проекта:
        powershell -ExecutionPolicy Bypass -File tools\build-bundle.ps1

    Необязательные параметры:
        -Dest  куда собирать (по умолчанию «..\Просмотр карт»)
        -Zip   заодно упаковать в архив рядом с папкой
#>
[CmdletBinding()]
param(
  [string]$Dest = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\Просмотр карт'),
  [switch]$Zip
)

$ErrorActionPreference = 'Stop'
$src = Split-Path $PSScriptRoot -Parent
$Dest = [IO.Path]::GetFullPath($Dest)
$app = Join-Path $Dest 'app'

# node.exe берём от того Node, которым сейчас пользуемся. Он самодостаточен:
# CRT слинкован статически, внешних библиотек не требует.
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'node.exe не найден в PATH — установите Node.js на машине сборки.' }

if (-not (Test-Path (Join-Path $src 'node_modules\better-sqlite3\prebuilds\win32-x64.node'))) {
  throw 'Нет node_modules с готовым бинарником. Выполните сначала: npm install'
}

Write-Host "сборка комплекта" -ForegroundColor Cyan
Write-Host "  из:  $src"
Write-Host "  в:   $Dest"
Write-Host "  node: $nodeExe"

if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
foreach ($d in @($Dest, $app, "$app\node", "$app\cache", (Join-Path $Dest 'карты'))) {
  New-Item -ItemType Directory -Path $d -Force | Out-Null
}

Copy-Item -LiteralPath (Join-Path $src 'server.js')    -Destination $app
Copy-Item -LiteralPath (Join-Path $src 'start.js')     -Destination $app
Copy-Item -LiteralPath (Join-Path $src 'package.json') -Destination $app
foreach ($d in 'lib', 'public', 'tools', 'node_modules') {
  Copy-Item -LiteralPath (Join-Path $src $d) -Destination $app -Recurse
}
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $app 'node\node.exe')

# Кэш указателя привязан к путям машины сборки — на целевой он бесполезен
# и только собьёт с толку. Пусть строится заново.
Remove-Item -LiteralPath (Join-Path $app 'cache\index.json') -ErrorAction SilentlyContinue

# Тексты для человека: BOM и CRLF, чтобы «Блокнот» на любой Windows
# показал кириллицу правильно.
foreach ($t in (Get-ChildItem -LiteralPath $Dest -Recurse -Filter *.txt)) {
  $text = [IO.File]::ReadAllText($t.FullName, [Text.UTF8Encoding]::new($false))
  $text = $text -replace "(?<!`r)`n", "`r`n"
  [IO.File]::WriteAllText($t.FullName, $text, [Text.UTF8Encoding]::new($true))
}

$bat = Join-Path $Dest 'ЗАПУСТИТЬ.bat'
if (-not (Test-Path -LiteralPath $bat)) {
  Write-Warning "ЗАПУСТИТЬ.bat не скопирован — положите его в $Dest вручную."
} else {
  # В .bat не должно быть ни одного не-ASCII байта: файл читается консолью
  # в её кодировке, и кириллица там сломается на чужой машине.
  $bytes = [IO.File]::ReadAllBytes($bat)
  $bad = @($bytes | Where-Object { $_ -gt 127 }).Count
  if ($bad -gt 0) { Write-Warning "В ЗАПУСТИТЬ.bat $bad не-ASCII байт — проверьте кодировку." }
}

$files = Get-ChildItem -LiteralPath $Dest -Recurse -File
Write-Host ("готово: {0} файлов, {1:N0} МБ" -f $files.Count, (($files | Measure-Object Length -Sum).Sum / 1MB)) -ForegroundColor Green

if ($Zip) {
  $archive = "$Dest.zip"
  Remove-Item -LiteralPath $archive -ErrorAction SilentlyContinue
  Compress-Archive -Path $Dest -DestinationPath $archive -CompressionLevel Optimal
  Write-Host ("архив: {0} ({1:N0} МБ)" -f $archive, ((Get-Item -LiteralPath $archive).Length / 1MB)) -ForegroundColor Green
}
