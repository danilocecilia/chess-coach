<#
  Fullscreen drag-to-select overlay. Prints {"x":..,"y":..,"w":..,"h":..} on stdout.

  Spans the whole virtual desktop so it works with multiple monitors, including
  ones positioned to the left of or above the primary (which gives negative
  coordinates — hence the offset handling rather than assuming 0,0).
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'
$form.Location        = New-Object System.Drawing.Point($vs.X, $vs.Y)
$form.Size            = New-Object System.Drawing.Size($vs.Width, $vs.Height)
$form.TopMost         = $true
$form.BackColor       = [System.Drawing.Color]::Black
$form.Opacity         = 0.35
$form.Cursor          = [System.Windows.Forms.Cursors]::Cross
$form.Text            = 'Drag around the chess board'

$script:startPt = $null
$script:rect    = [System.Drawing.Rectangle]::Empty
$script:done    = $false

$pen  = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 129, 182, 76)), 2
$font = New-Object System.Drawing.Font 'Segoe UI', 14
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

$form.Add_Paint({
  param($s, $e)
  $hint = 'Drag a rectangle around the board.  Esc to cancel.'
  $e.Graphics.DrawString($hint, $font, $brush, 24, 24)
  if ($script:rect.Width -gt 0 -and $script:rect.Height -gt 0) {
    $e.Graphics.DrawRectangle($pen, $script:rect)
    $label = "$($script:rect.Width) x $($script:rect.Height)"
    $e.Graphics.DrawString($label, $font, $brush, $script:rect.X, [math]::Max(0, $script:rect.Y - 28))
  }
})

$form.Add_MouseDown({
  param($s, $e)
  $script:startPt = $e.Location
  $script:rect = [System.Drawing.Rectangle]::Empty
})

$form.Add_MouseMove({
  param($s, $e)
  if ($null -eq $script:startPt) { return }
  $x = [math]::Min($script:startPt.X, $e.X); $y = [math]::Min($script:startPt.Y, $e.Y)
  $w = [math]::Abs($e.X - $script:startPt.X); $h = [math]::Abs($e.Y - $script:startPt.Y)
  $script:rect = New-Object System.Drawing.Rectangle $x, $y, $w, $h
  $s.Invalidate()
})

$form.Add_MouseUp({
  param($s, $e)
  if ($script:rect.Width -gt 20 -and $script:rect.Height -gt 20) { $script:done = $true; $s.Close() }
  $script:startPt = $null
})

$form.Add_KeyDown({
  param($s, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $script:done = $false; $s.Close() }
})
$form.KeyPreview = $true

[void]$form.ShowDialog()

if ($script:done) {
  # Form coordinates are relative to the virtual screen origin; convert to absolute.
  $x = $script:rect.X + $vs.X
  $y = $script:rect.Y + $vs.Y
  [Console]::Out.WriteLine("{""ok"":true,""x"":$x,""y"":$y,""w"":$($script:rect.Width),""h"":$($script:rect.Height)}")
} else {
  [Console]::Out.WriteLine('{"ok":false,"error":"cancelled"}')
}
