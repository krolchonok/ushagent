param(
  [Parameter(Mandatory = $true)]
  [string]$Token,

  [string]$ChatId = "-1003802988733",

  [string]$TestHome = "C:\Users\krol\ushagent\.tmp\forum-home",

  [string]$InstallRoot = "C:\Users\krol\ushagent\.tmp\forum-install",

  [string]$SourceCodexDir = ([System.IO.Path]::Combine([Environment]::GetFolderPath("UserProfile"), ".codex")),

  [int]$UpdateCursor = 705137474,

  [switch]$ResetTopics,

  [switch]$DebugCodexStream
)

$ErrorActionPreference = "Stop"

$configDir = Join-Path $TestHome ".ushagent"
$configPath = Join-Path $configDir "config.json"
$ushagentCmd = Join-Path $InstallRoot "node_modules\.bin\ushagent.cmd"
$testCodexDir = Join-Path $TestHome ".codex"

if (-not (Test-Path $ushagentCmd)) {
  throw "Test ushagent binary not found: $ushagentCmd"
}

New-Item -ItemType Directory -Force -Path $configDir | Out-Null

if (Test-Path $SourceCodexDir) {
  if (Test-Path $testCodexDir) {
    Remove-Item -Path $testCodexDir -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $TestHome | Out-Null
  Copy-Item -Path $SourceCodexDir -Destination $TestHome -Recurse -Force
} else {
  Write-Warning "Source .codex directory not found: $SourceCodexDir"
}

$config = [ordered]@{}

if (Test-Path $configPath) {
  try {
    $rawConfig = Get-Content -Path $configPath -Raw -Encoding UTF8
    if ($rawConfig.Trim()) {
      $loadedConfig = $rawConfig | ConvertFrom-Json
      if ($null -ne $loadedConfig) {
        foreach ($property in $loadedConfig.PSObject.Properties) {
          $config[$property.Name] = $property.Value
        }
      }
    }
  } catch {
    Write-Warning "Existing config could not be parsed. Recreating $configPath."
  }
}

$config["provider"] = "codex"
$config["telegramChatId"] = $ChatId

if (-not $config.Contains("telegramUpdateCursor")) {
  $config["telegramUpdateCursor"] = $UpdateCursor
}

if ($ResetTopics) {
  $config["telegramForum"] = @{
    enabled = $false
    chatId = $null
    mainThreadId = $null
    topics = @{}
  }
  $config["telegramControlPanelMessageIds"] = @{}
  $config["telegramControlPanelMessageId"] = $null
}

$json = $config | ConvertTo-Json -Depth 20

[System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))

$env:USERPROFILE = $TestHome
$env:HOME = $TestHome
$env:USHAGENT_TELEGRAM_BOT_TOKEN = $Token
$env:USHAGENT_CODEX_DEBUG_STREAM = if ($DebugCodexStream) { "1" } else { "0" }

Write-Host "Test HOME: $TestHome"
Write-Host "Config: $configPath"
Write-Host "Chat ID: $ChatId"
Write-Host "Binary: $ushagentCmd"
Write-Host "Source Codex dir: $SourceCodexDir"
Write-Host "Codex dir: $testCodexDir"
Write-Host "Reset topics: $($ResetTopics.IsPresent)"
Write-Host "Debug Codex stream: $($DebugCodexStream.IsPresent)"
Write-Host ""

& $ushagentCmd codex
