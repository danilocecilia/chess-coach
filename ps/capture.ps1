<#
  Screen capture daemon for chess-coach.

  Exists because Smart App Control blocks unsigned native code on this machine,
  which rules out numpy/OpenCV/mss. System.Drawing is a signed Microsoft
  assembly, so it is allowed — and its native scaler does the heavy pixel work
  for us, which also keeps PowerShell out of any large per-pixel loop.

  Protocol: one command per stdin line, one JSON object per stdout line.
    grab            -> {"ok":true,"stride":N,"data":"<base64 BGRA>"}
    raw             -> {"ok":true,"w":W,"h":H,"stride":N,"data":"<base64 BGRA>"}
    snap <path>     -> {"ok":true,"path":"..."}
    region x y w h  -> {"ok":true}        (retarget without restarting)
    quit            -> exits

  `grab` returns the board downsampled to SAMPLE*8 x SAMPLE*8, as raw 32bpp
  BGRA rows of `stride` bytes -- straight out of GDI+, unprocessed.

  `raw` returns the region at its native size instead, and exists for the move
  list: a glyph is a dozen pixels tall, so the downsample that makes a board
  cheap to match destroys text outright. It is deliberately a separate command
  rather than a flag on `grab`, because `grab`'s output is what templates were
  calibrated against and what recorded sessions replay through -- see the
  rounding comment in src/capture.js. Nothing about `grab` may move.

  It is also far more data per frame (no 8x8 reduction), which is affordable
  only because the move list does not need the board's poll rate: the panel is
  read to confirm and correct a move, not to spot one mid-animation.

  Turning that into the grayscale square-major layout the consumer actually
  wants is a per-pixel loop, and PowerShell is about two orders of magnitude
  too slow at those: it measured 56ms/frame at SAMPLE=16 against a 150ms poll.
  So that loop now lives in Node (repack() in src/capture.js) and this script
  does only the work GDI+ can do for us in native code. Keep it that way --
  anything per-pixel added here comes straight off the frame budget.
#>

param(
  [int]$X = 0, [int]$Y = 0, [int]$W = 800, [int]$H = 800,
  [int]$Sample = 8
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$side = $Sample * 8

# Reused across frames so we are not allocating bitmaps 3x a second.
$full  = New-Object System.Drawing.Bitmap $W, $H
$small = New-Object System.Drawing.Bitmap $side, $side
$gFull = [System.Drawing.Graphics]::FromImage($full)
$gSmall = [System.Drawing.Graphics]::FromImage($small)
$gSmall.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

function Resize-Buffers([int]$nw, [int]$nh) {
  $script:gFull.Dispose(); $script:full.Dispose()
  $script:full = New-Object System.Drawing.Bitmap $nw, $nh
  $script:gFull = [System.Drawing.Graphics]::FromImage($script:full)
}

function Get-Frame {
  # Grab the board region, then let GDI+ downsample it in native code.
  $gFull.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
  $gSmall.DrawImage($full, 0, 0, $side, $side)

  $rect = New-Object System.Drawing.Rectangle 0, 0, $side, $side
  $bits = $small.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $stride = $bits.Stride
    $raw = New-Object byte[] ($stride * $side)
    [System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $raw, 0, $raw.Length)
  } finally {
    $small.UnlockBits($bits)
  }

  # Stride travels with the pixels rather than being rederived from the width:
  # LockBits is free to pad rows, and for 32bpp it happens not to today, but
  # nothing in the contract promises that.
  return @{ data = [Convert]::ToBase64String($raw); stride = $stride }
}

# Signal readiness so the Node side does not race the first grab.
[Console]::Out.WriteLine('{"ok":true,"ready":true,"sample":' + $Sample + '}')
[Console]::Out.Flush()

$running = $true
while ($running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }

  try {
    $parts = $line -split '\s+'
    switch ($parts[0]) {
      'grab' {
        $f = Get-Frame
        [Console]::Out.WriteLine('{"ok":true,"stride":' + $f.stride + ',"data":"' + $f.data + '"}')
      }
      'raw' {
        # Native resolution: skip $small entirely and lock $full itself.
        $gFull.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
        $r = New-Object System.Drawing.Rectangle 0, 0, $W, $H
        $b = $full.LockBits($r, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                            [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
          $stride = $b.Stride
          $buf = New-Object byte[] ($stride * $H)
          [System.Runtime.InteropServices.Marshal]::Copy($b.Scan0, $buf, 0, $buf.Length)
        } finally {
          $full.UnlockBits($b)
        }
        [Console]::Out.WriteLine('{"ok":true,"w":' + $W + ',"h":' + $H + ',"stride":' + $stride +
                                 ',"data":"' + [Convert]::ToBase64String($buf) + '"}')
      }
      'snap' {
        $path = $line.Substring(5).Trim()
        $gFull.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
        $full.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        [Console]::Out.WriteLine('{"ok":true,"path":' + ($path | ConvertTo-Json) + '}')
      }
      'region' {
        $script:X = [int]$parts[1]; $script:Y = [int]$parts[2]
        $nw = [int]$parts[3]; $nh = [int]$parts[4]
        if ($nw -ne $W -or $nh -ne $H) { $script:W = $nw; $script:H = $nh; Resize-Buffers $nw $nh }
        [Console]::Out.WriteLine('{"ok":true}')
      }
      'quit' { $running = $false }
      default { [Console]::Out.WriteLine('{"ok":false,"error":"unknown command"}') }
    }
  } catch {
    $msg = $_.Exception.Message | ConvertTo-Json
    [Console]::Out.WriteLine('{"ok":false,"error":' + $msg + '}')
  }
  [Console]::Out.Flush()
}

$gSmall.Dispose(); $small.Dispose(); $gFull.Dispose(); $full.Dispose()
