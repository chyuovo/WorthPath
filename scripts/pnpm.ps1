param([Parameter(ValueFromRemainingArguments=$true)][string[]]$PnpmArgs)
$ErrorActionPreference = 'Stop'
$manager = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($manager) { $executable=$manager.Source } else {
  $executable=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
  if (!(Test-Path -LiteralPath $executable)) { throw 'pnpm is not installed. Install pnpm 11 using your Node.js package manager first.' }
}
if (!$PnpmArgs.Count) { $PnpmArgs=@('dev') }
Push-Location (Split-Path $PSScriptRoot -Parent)
try { & $executable @PnpmArgs; exit $LASTEXITCODE } finally { Pop-Location }
