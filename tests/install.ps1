#requires -Version 7.2
param([string]$CodexPath, [string]$UxScreenshot)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
# Opt-in. The UX smoke test sends the selected PNG to Claude Code using its existing login.
$uxInput = if ($UxScreenshot) { (Resolve-Path -LiteralPath $UxScreenshot).Path }
$codex = if ($CodexPath) { (Resolve-Path -LiteralPath $CodexPath).Path }
         else { (Get-Command codex -CommandType Application | Select-Object -First 1).Source }
$launcherArgs = @()
if ([IO.Path]::GetExtension($codex) -in '.cmd', '.ps1') {
    # ProcessStartInfo with UseShellExecute=false needs an executable. npm's
    # global and project shims both point at @openai/codex/bin/codex.js.
    $shimDir = Split-Path -Parent $codex
    $packageDir = if ((Split-Path -Leaf $shimDir) -eq '.bin') { Split-Path -Parent $shimDir }
                  else { Join-Path $shimDir 'node_modules' }
    $entry = (Resolve-Path -LiteralPath (Join-Path $packageDir '@openai/codex/bin/codex.js')).Path
    $codex = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $launcherArgs = @($entry)
}
$tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$trial = Join-Path $tempRoot ('metodo-install-' + [guid]::NewGuid().ToString('N'))
$catalog = Join-Path $trial 'marketplace'
$profilePath = Join-Path $trial 'codex-profile'
$project = Join-Path $trial 'sample-project'

function Start-TrialCodex([string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($codex)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $project
    $info.Environment['CODEX_HOME'] = $profilePath
    # This probe operates entirely through local CLI commands and stdio RPC.
    foreach ($key in 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN') {
        $null = $info.Environment.Remove($key)
    }
    foreach ($key in 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY') {
        $info.Environment[$key] = 'http://127.0.0.1:1'
    }
    $info.Environment['NO_PROXY'] = 'localhost,127.0.0.1'
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    foreach ($argument in ($launcherArgs + $Arguments)) { $info.ArgumentList.Add($argument) }
    [Diagnostics.Process]::Start($info)
}

function Invoke-TrialCodex([string[]]$Arguments) {
    $process = Start-TrialCodex $Arguments
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(60000)) { throw "Timeout: codex $Arguments" }
        if ($process.ExitCode -ne 0) { throw "codex $Arguments - $($stderr.Result)" }
        $stdout.Result
    } finally {
        if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
        $process.Dispose()
    }
}

function Read-Reply($Process, [int]$Id) {
    $deadline = [datetime]::UtcNow.AddSeconds(40)
    while ([datetime]::UtcNow -lt $deadline) {
        $lineTask = $Process.StandardOutput.ReadLineAsync()
        $remaining = $deadline - [datetime]::UtcNow
        if ($remaining.TotalMilliseconds -le 0 -or -not $lineTask.Wait($remaining)) { break }
        if ($null -eq $lineTask.Result) { throw "App server ended before response $Id" }
        $reply = $lineTask.Result | ConvertFrom-Json
        if ($null -ne $reply.id -and $reply.id -eq $Id) {
            if ($reply.error) { throw ($reply.error | ConvertTo-Json -Compress) }
            return $reply.result
        }
    }
    throw "Timeout waiting for app-server response $Id"
}

function Test-SkillDiscovery([switch]$RunUx) {
    $process = Start-TrialCodex @('app-server', '--stdio')
    try {
        $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"metodo_test","version":"0.1.0"}}}')
        $null = Read-Reply $process 1
        $process.StandardInput.WriteLine('{"method":"initialized"}')
        $request = @{ id = 2; method = 'skills/list'; params = @{ cwds = @($project); forceReload = $true } }
        $process.StandardInput.WriteLine(($request | ConvertTo-Json -Depth 4 -Compress))
        $discovery = Read-Reply $process 2
        $cache = Join-Path $profilePath 'plugins/cache/crew-tools/build-with-the-crew'
        $installedRoot = $null
        foreach ($entry in $expected) {
            # Verify the runtime returns this installed file, including its complete bytes.
            $hit = @($discovery.data.skills | Where-Object {
                $_.enabled -and $_.path -and [IO.Path]::GetFullPath($_.path).StartsWith(
                    $cache + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase
                ) -and (Split-Path -Leaf (Split-Path -Parent $_.path)) -ceq $entry.Directory.Name
            })
            if ($hit.Count -ne 1) { throw "Expected one enabled cached skill for $($entry.Directory.Name), got $($hit.Count)" }
            $installedRoot = (Get-Item -LiteralPath $hit[0].path).Directory.Parent.Parent.FullName
        }
        $sourceRoot = Join-Path $catalog 'plugins/build-with-the-crew'
        $files = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force)
        foreach ($file in $files) {
            $relative = [IO.Path]::GetRelativePath($sourceRoot, $file.FullName)
            $installed = Join-Path $installedRoot $relative
            if ((Get-FileHash -LiteralPath $installed).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
                throw "Installed package file differs from catalog: $relative"
            }
        }
        Write-Output ("Discovered {0} enabled skills from the installed copy: {1}" -f $expected.Count, ($expected.Directory.Name -join ', '))
        Write-Output "Verified all $($files.Count) package files in the active cache."
    } finally {
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(2000)) { $process.Kill($true); $process.WaitForExit() }
        $process.Dispose()
    }
    if ($RunUx -and $uxInput) {
        $previous = $env:METODO_SMOKE_PLUGIN
        try {
            $env:METODO_SMOKE_PLUGIN = $installedRoot
            & node (Join-Path $PSScriptRoot 'specialist-smoke.mjs') --ux $uxInput
            if ($LASTEXITCODE -ne 0) { throw "Installed plugin UX smoke failed ($LASTEXITCODE)" }
        } finally {
            $env:METODO_SMOKE_PLUGIN = $previous
        }
    }
}

try {
    $null = New-Item -ItemType Directory -Path $profilePath, $project, $catalog
    Copy-Item -LiteralPath (Join-Path $source '.agents'), (Join-Path $source 'plugins') -Destination $catalog -Recurse
    [IO.File]::WriteAllText((Join-Path $profilePath 'config.toml'), 'cli_auth_credentials_store = "file"')
    & git -C $project init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize the disposable test repository' }
    $projectConfig = Join-Path $project '.build-with-the-crew/config.json'
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $projectConfig)
    [IO.File]::WriteAllText($projectConfig, '{"project":"integration-fixture"}')
    $before = (Get-FileHash -LiteralPath $projectConfig).Hash
    $skillRoot = Join-Path $catalog 'plugins/build-with-the-crew/skills'
    $expected = @(Get-ChildItem -Directory -LiteralPath $skillRoot | ForEach-Object {
        Get-Item -LiteralPath (Join-Path $_.FullName 'SKILL.md')
    })
    if (-not $expected.Count) { throw 'Plugin catalog contains no skills' }
    $manifestPath = Join-Path $catalog 'plugins/build-with-the-crew/.codex-plugin/plugin.json'
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $release = $manifest.version
    Write-Output ((Invoke-TrialCodex @('--version')).Trim())
    $register = Invoke-TrialCodex @('plugin', 'marketplace', 'add', $catalog, '--json') | ConvertFrom-Json
    if ($register.marketplaceName -ne 'crew-tools') { throw 'Unexpected marketplace name' }
    $null = Invoke-TrialCodex @('plugin', 'add', 'build-with-the-crew@crew-tools', '--json')
    Test-SkillDiscovery -RunUx
    # Bump only the disposable catalog, so a stale cached copy fails the check above.
    $manifest.version = "$release-installtest"
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10))
    [IO.File]::AppendAllText($expected[0].FullName, ([Environment]::NewLine + 'Temporary test revision.'))
    $null = Invoke-TrialCodex @('plugin', 'remove', 'build-with-the-crew@crew-tools')
    $null = Invoke-TrialCodex @('plugin', 'add', 'build-with-the-crew@crew-tools', '--json')
    Test-SkillDiscovery
    if ((Get-FileHash -LiteralPath $projectConfig).Hash -ne $before) { throw 'Project settings changed on reinstall' }
    Write-Output "PASS clean install of build-with-the-crew $release and reinstall of a modified test version, project settings preserved."
} finally {
    if (Test-Path -LiteralPath $trial) {
        $owned = (Resolve-Path -LiteralPath $trial).Path
        if ((Split-Path -Parent $owned) -ne $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) -or
            (Split-Path -Leaf $owned) -notmatch '^metodo-install-[0-9a-f]{32}$') { throw "Unexpected temporary path: $owned" }
        # Windows can hold directory handles briefly after the server exits.
        $deadline = [datetime]::UtcNow.AddSeconds(15)
        do {
            try {
                Remove-Item -LiteralPath $owned -Recurse -Force
                break
            } catch {
                if ([datetime]::UtcNow -ge $deadline) { throw }
                Start-Sleep -Milliseconds 350
            }
        } while (Test-Path -LiteralPath $owned)
    }
}
