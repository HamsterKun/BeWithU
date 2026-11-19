[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Path,
    [string] $ExpectedSha256 = $env:BEWITHU_INSTALLER_SHA256,
    [string] $PublisherCertSha256 = $env:BEWITHU_PUBLISHER_CERT_SHA256,
    [switch] $Launch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ExpectedSha256 -and -not $PublisherCertSha256) {
    throw 'Configure an expected SHA-256 from a trusted release manifest or a trusted publisher certificate SHA-256 pin.'
}
foreach ($expected in @($ExpectedSha256, $PublisherCertSha256)) {
    if ($expected -and $expected -notmatch '\A[0-9A-Fa-f]{64}\z') {
        throw 'Expected SHA-256 values must be exactly 64 hexadecimal characters.'
    }
}

$item = Get-Item -LiteralPath $Path
if ($item -isnot [IO.FileInfo] -or $item.Extension -ne '.exe') {
    throw 'The installer path must name an existing .exe file.'
}

# Keep the executable open for reading until after launch, denying concurrent writes and deletion.
$stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    if ($ExpectedSha256) {
        $actual = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
        if ($actual -ne $ExpectedSha256) { throw 'Installer SHA-256 mismatch.' }
    }
    if ($PublisherCertSha256) {
        $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
        if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
            throw "Installer Authenticode signature is not valid: $($signature.Status)."
        }
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $actualPin = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '')
        } finally {
            $sha256.Dispose()
        }
        if ($actualPin -ne $PublisherCertSha256) { throw 'Installer publisher certificate SHA-256 mismatch.' }
    }

    Write-Output "Installer verified: $($item.FullName)"
    if ($Launch) {
        # Use the normal Windows shell so OS installation prompts and protections remain in force.
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $item.FullName
        $start.UseShellExecute = $true
        [void][Diagnostics.Process]::Start($start)
    }
} finally {
    $stream.Dispose()
}
