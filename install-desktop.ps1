$ErrorActionPreference = 'Stop'
$desktopExecutable = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $desktopExecutable)) {
    throw 'DeepSeek Harness Desktop is not installed at the standard location.'
}
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $desktopExecutable --expose-internals (Join-Path $PSScriptRoot 'install-desktop.mjs') 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "DSH package installation failed with exit code $LASTEXITCODE." }
    $dshHomePath = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $profileDirectory = Join-Path $dshHomePath 'profiles/desktop'
    $profileManifest = Get-Content -LiteralPath (Join-Path $profileDirectory 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
    if (-not $profileManifest.dependencies.'dsh-model-cost' -or
        'dsh-model-cost' -notin $profileManifest.dsh.profile.bundles -or
        -not (Test-Path -LiteralPath (Join-Path $profileDirectory 'node_modules/dsh-model-cost/package.json'))) {
        throw 'Installation did not persist an enabled model-cost bundle in the Desktop profile.'
    }
    Write-Output 'Package installed. Restart Desktop to load the Host service.'
} finally {
    $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
}
