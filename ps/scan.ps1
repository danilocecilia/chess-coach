<#
  One-shot grab of an arbitrary rectangle, downsampled to an arbitrary size.

    scan.ps1 -X 0 -Y 0 -W 1920 -H 1080 -OutW 480 -OutH 270
    -> {"ok":true,"w":480,"h":270,"data":"<base64 grayscale, row-major>"}

  Separate from capture.ps1 on purpose. That daemon exists to serve a board: it
  always emits a square SAMPLE*8 image in square-major order, because every
  consumer downstream slices squares out of it. A board *search* needs the
  opposite — a whole monitor, in its true aspect ratio, as a plain image. Faking
  it with the daemon would mean grabbing a 16:9 monitor into a square buffer,
  which makes a chess board rectangular and the two axes differently scaled, so
  the search would have to look for a different pitch per axis.

  Keeping the aspect means the caller can pick OutW/OutH so that one scan pixel
  is the same number of screen pixels in both directions. A board is then square
  in the scan too, and one pitch describes it.

  System.Drawing only, like everything else here: Smart App Control blocks
  unsigned native code on this machine.
#>

param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [Parameter(Mandatory = $true)][int]$OutW,
  [Parameter(Mandatory = $true)][int]$OutH
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

try {
  $full = New-Object System.Drawing.Bitmap $W, $H
  $gFull = [System.Drawing.Graphics]::FromImage($full)
  $gFull.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))

  $small = New-Object System.Drawing.Bitmap $OutW, $OutH
  $gSmall = [System.Drawing.Graphics]::FromImage($small)
  # Bicubic, so a thin board edge survives the downsample as a grey rather than
  # being dropped entirely by nearest-neighbour.
  $gSmall.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gSmall.DrawImage($full, 0, 0, $OutW, $OutH)

  $rect = New-Object System.Drawing.Rectangle 0, 0, $OutW, $OutH
  $bits = $small.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $stride = $bits.Stride
    $raw = New-Object byte[] ($stride * $OutH)
    [System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $raw, 0, $raw.Length)
  } finally {
    $small.UnlockBits($bits)
  }

  $out = New-Object byte[] ($OutW * $OutH)
  for ($r = 0; $r -lt $OutH; $r++) {
    $rowOff = $r * $stride
    $dst = $r * $OutW
    for ($c = 0; $c -lt $OutW; $c++) {
      $p = $rowOff + $c * 4                       # BGRA
      # Rec. 601 luma, integer maths to stay fast.
      $lum = (($raw[$p + 2] * 299) + ($raw[$p + 1] * 587) + ($raw[$p] * 114)) / 1000
      $out[$dst + $c] = [byte]$lum
    }
  }

  [Console]::Out.WriteLine('{"ok":true,"w":' + $OutW + ',"h":' + $OutH +
    ',"data":"' + [Convert]::ToBase64String($out) + '"}')
} catch {
  [Console]::Out.WriteLine('{"ok":false,"error":' + ($_.Exception.Message | ConvertTo-Json) + '}')
} finally {
  if ($gSmall) { $gSmall.Dispose() }
  if ($small)  { $small.Dispose() }
  if ($gFull)  { $gFull.Dispose() }
  if ($full)   { $full.Dispose() }
}
[Console]::Out.Flush()
