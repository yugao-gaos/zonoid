<#
.SYNOPSIS
  Install / uninstall the zonoid orchestrator daemon as a Windows scheduled task that starts at logon.

.DESCRIPTION
  The daemon was being started by hand after every reboot, which is one of the restart-shaped ops
  this replaces. Registering it as a scheduled task with an AtLogOn trigger makes the daemon come
  back on its own, in the right working directory, with the right node binary.

  Why a SCHEDULED TASK and not a real Windows service:
    - A service runs in session 0 with no user profile, so the agentic CLI backends (which
      authenticate against the interactive user's profile) cannot authenticate. The daemon spawns
      those CLIs, so it must run AS the interactive user.
    - No third-party service wrapper (nssm / winsw) is needed — schtasks ships with Windows.

  LOGGING is deliberately NOT re-plumbed here: the daemon already tees stdout/stderr to
  <runtime dir>\daemon.log via lib/daemon-log.js (size-rotated, always on). This script only
  reports where that file is. Set ORCH_DAEMON_LOG before -Install to override the location.

.PARAMETER Install
  Register (or re-register — it is idempotent) the scheduled task.

.PARAMETER Uninstall
  Unregister the scheduled task. Does not stop an already-running daemon; pass -Stop for that.

.PARAMETER Status
  Print the task's registration state, last run time and last result.

.PARAMETER Start
  Run the registered task now.

.PARAMETER Stop
  Stop the running task instance.

.PARAMETER TaskName
  Scheduled task name. Default: ZonoidOrchestrator.

.PARAMETER RepoPath
  Repository root that becomes the task's working directory. Default: the repo containing this script.

.PARAMETER NodePath
  node.exe to launch. Default: whichever node is first on PATH.

.PARAMETER Port
  ORCH_PORT for the daemon. Default: unset (the daemon's own default, 8787).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Install
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Status
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$Start,
  [switch]$Stop,
  [string]$TaskName = 'ZonoidOrchestrator',
  [string]$RepoPath,
  [string]$NodePath,
  [string]$Port
)

$ErrorActionPreference = 'Stop'

if (-not $RepoPath) { $RepoPath = Split-Path -Parent $PSScriptRoot }
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path

$daemonJs = Join-Path $RepoPath 'daemon.js'
if (-not (Test-Path -LiteralPath $daemonJs)) {
  throw "daemon.js not found under '$RepoPath' — pass -RepoPath <repo root>."
}

if (-not $NodePath) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if (-not $found) { throw 'node.exe not found on PATH — pass -NodePath "C:\Program Files\nodejs\node.exe".' }
  $NodePath = $found.Source
}

function Get-Task {
  try { Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $null }
}

function Show-LogPath {
  # Ask the repo itself where the runtime dir is, so this script never re-derives that logic.
  try {
    $dir = & $NodePath -e "process.stdout.write(require('$($RepoPath -replace '\\','/')/lib/runtime-paths').resolveDataDir())"
    if ($dir) { Write-Host "  daemon log : $dir\daemon.log" }
  } catch { Write-Host '  daemon log : (runtime dir not resolvable yet)' }
}

function Invoke-Install {
  # -NoProfile keeps the launch deterministic; ORCH_PORT is injected via a wrapper command only when
  # the caller asked for a specific port (otherwise the daemon's own default applies).
  $arguments = "`"$daemonJs`""
  if ($Port) {
    $execute  = 'powershell.exe'
    $arguments = "-NoProfile -WindowStyle Hidden -Command `"`$env:ORCH_PORT='$Port'; & '$NodePath' '$daemonJs'`""
  } else {
    $execute = $NodePath
  }

  $action = New-ScheduledTaskAction -Execute $execute -Argument $arguments -WorkingDirectory $RepoPath
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # Run as the INTERACTIVE user (see .DESCRIPTION): the daemon spawns user-authed CLI backends.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)   # 0 = no time limit: this is a long-lived daemon

  if (Get-Task) {
    Write-Host "Re-registering existing task '$TaskName'..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }

  Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "zonoid orchestrator daemon (repo: $RepoPath)" | Out-Null

  Write-Host "Installed scheduled task '$TaskName':"
  Write-Host "  node       : $NodePath"
  Write-Host "  working dir: $RepoPath"
  Write-Host "  trigger    : at logon ($env:USERNAME)"
  if ($Port) { Write-Host "  ORCH_PORT  : $Port" }
  Show-LogPath
  Write-Host ''
  Write-Host "Start it now with: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Start"
}

function Invoke-Uninstall {
  if (-not (Get-Task)) { Write-Host "Task '$TaskName' is not registered — nothing to do."; return }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Unregistered scheduled task '$TaskName'. A daemon already running is left alone (-Stop to stop it)."
}

function Invoke-Status {
  $task = Get-Task
  if (-not $task) { Write-Host "Task '$TaskName' is NOT registered."; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "Task '$TaskName':"
  Write-Host "  state      : $($task.State)"
  Write-Host "  last run   : $($info.LastRunTime)"
  Write-Host "  last result: $($info.LastTaskResult)"
  Write-Host "  next run   : $($info.NextRunTime)"
  Show-LogPath
}

if ($Install)        { Invoke-Install }
elseif ($Uninstall)  { Invoke-Uninstall }
elseif ($Status)     { Invoke-Status }
elseif ($Start)      { Start-ScheduledTask -TaskName $TaskName; Write-Host "Started '$TaskName'." }
elseif ($Stop)       { Stop-ScheduledTask -TaskName $TaskName; Write-Host "Stopped '$TaskName'." }
else {
  Write-Host 'Pass one of -Install / -Uninstall / -Status / -Start / -Stop. See: Get-Help .\scripts\windows-service.ps1 -Full'
  exit 1
}
