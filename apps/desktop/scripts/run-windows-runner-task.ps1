# Repeating Task Scheduler triggers recover an exited launcher without relying on action exit-code retries.
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot ('run-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + $PID + '.log')
try {
    @{ Pid = $PID; Started = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'process.json')
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    $attemptFile = Join-Path $PSScriptRoot 'attempts.txt'
    $attempts = [int](Get-Content -LiteralPath $attemptFile -Raw)
    if ($attempts -lt 0 -or $config.RestartCount -lt 1 -or $config.RestartCount -gt 999) { throw 'Invalid restart budget; reinstall the task.' }
    if ($attempts -gt $config.RestartCount) {
        $null = Disable-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
        Set-Content -LiteralPath $log -Value 'Restart budget exhausted. Task disabled; inspect runner logs, fix the cause and run start.'
        exit 1
    }
    Set-Content -LiteralPath $attemptFile -Value ($attempts + 1)
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'start.ps1') -RunnerRoot $config.RunnerRoot -ConfigRoot $config.ConfigRoot *> $log
    $code = $LASTEXITCODE
    Add-Content -LiteralPath $log -Value "Runner launcher exited with code $code."
    # run.cmd maps several listener failures to zero; a persistent task must stay alive until explicitly stopped.
    exit 1
} catch {
    $message = 'Runner task failed: ' + $_.Exception.Message
    [Console]::Error.WriteLine($message)
    Add-Content -LiteralPath $log -Value $message
    exit 1
}
