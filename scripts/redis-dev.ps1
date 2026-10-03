param(
    [string]$Context = 'docker-desktop',
    [string]$Namespace = 'default',
    [ValidateRange(1, 65535)][int]$LocalPort = 6379,
    [switch]$SkipApply
)

$ErrorActionPreference = 'Stop'
# Native kubectl failures are handled below, including retryable disconnects.
$PSNativeCommandUseErrorActionPreference = $false
$kubectl = (Get-Command kubectl -ErrorAction Stop).Source
$manifest = Join-Path (Split-Path $PSScriptRoot -Parent) 'redis.yaml'

$listener = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw "Port $LocalPort is already occupied by PID $($listener[0].OwningProcess). Stop that forward first, or choose -LocalPort 6380."
}

if (-not $SkipApply) {
    & $kubectl --context $Context -n $Namespace apply -f $manifest --request-timeout=30s
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply redis.yaml.' }
}

Write-Host "Redis forwarding supervisor: redis://127.0.0.1:$LocalPort"
Write-Host "Cluster: $Context / $Namespace. Keep this process running; Ctrl+C stops it."

while ($true) {
    # port-forward waits for a running pod itself. Do not gate forwarding on
    # Deployment availability: a slow exec readiness probe can report false
    # while Redis is already accepting connections.
    Write-Host "[$(Get-Date -Format HH:mm:ss)] Starting port-forward on 127.0.0.1:$LocalPort"
    & $kubectl --context $Context -n $Namespace port-forward svc/redis "${LocalPort}:6379" --address=127.0.0.1 --pod-running-timeout=60s
    $forwardExitCode = $LASTEXITCODE
    Write-Warning "Port-forward exited (code $forwardExitCode). Reconnecting in 3 seconds."
    Start-Sleep -Seconds 3
}
