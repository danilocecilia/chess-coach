<#
  Decode a PNG to raw 32bpp BGRA, for re-reading a capture without taking one.

  The same System.Drawing that ps/capture.ps1 uses, for the same reason: it is
  a signed Microsoft assembly, so it runs where a native image library would be
  blocked by Smart App Control.

  Emits the same shape as capture.ps1's `raw`, so both feed one decoder in Node:
    {"ok":true,"w":W,"h":H,"stride":N,"data":"<base64 BGRA>"}
#>

param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Path))
try {
  $rect = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
  $bits = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $raw = New-Object byte[] ($bits.Stride * $bmp.Height)
    [System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $raw, 0, $raw.Length)
    [Console]::Out.WriteLine('{"ok":true,"w":' + $bmp.Width + ',"h":' + $bmp.Height +
      ',"stride":' + $bits.Stride + ',"data":"' + [Convert]::ToBase64String($raw) + '"}')
  } finally {
    $bmp.UnlockBits($bits)
  }
} finally {
  $bmp.Dispose()
}
