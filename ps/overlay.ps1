<#
  Always-on-top verdict overlay.

  State arrives via a JSON file rather than stdin: a WinForms message loop and a
  blocking Console.In.ReadLine() cannot coexist without freezing the UI, and
  polling a small file every 100ms is both simpler and impossible to deadlock.
  Node writes that file atomically, so a half-written read is not possible.

  The window is click-through-free and draggable, so it can be parked anywhere.

  Colours arrive in the state file too, under `ink`. They used to be typed here
  as literals — including the hint teal as FromArgb(27, 172, 166), which is the
  Brilliant grade colour that verdict.js already owns, written a third time in
  decimal. The defaults below are only what paints before the first read.
#>

param(
  [Parameter(Mandatory = $true)][string]$StateFile,
  [string]$HintFile,
  [int]$X = 40, [int]$Y = 40
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$W = 430
$H = 180
$PAD = 18

# Figtree is the design system's face, but WinForms cannot read the woff2 the
# page inlines — it needs the family installed. Ask for it, take Segoe UI when
# it is not there. A Font built on a missing family resolves to something else
# silently, and comparing .Name back is the only way to find out.
function Select-Font([string[]]$Names, [single]$Size, [System.Drawing.FontStyle]$Style) {
  foreach ($n in $Names) {
    $f = New-Object System.Drawing.Font $n, $Size, $Style
    if ($f.Name -eq $n) { return $f }
    $f.Dispose()
  }
  return New-Object System.Drawing.Font 'Segoe UI', $Size, $Style
}

$sans = @('Figtree', 'Segoe UI')
$mono = @('JetBrains Mono', 'Consolas')
$fontVerdict = Select-Font $sans 19 ([System.Drawing.FontStyle]::Bold)
$fontBadge   = Select-Font $sans 15 ([System.Drawing.FontStyle]::Bold)
$fontSan     = Select-Font $mono 11 ([System.Drawing.FontStyle]::Bold)
$fontEval    = Select-Font $mono  9 ([System.Drawing.FontStyle]::Regular)
$fontWhy     = Select-Font $sans 10 ([System.Drawing.FontStyle]::Regular)
$fontHint    = Select-Font $sans 10 ([System.Drawing.FontStyle]::Bold)

# What the first paint uses; Node replaces all of it on the first tick.
$script:ink = @{
  bg = '#262421'; verdict = '#ffffff'; eval = '#a8a6a3';
  why = '#c3c2c0'; hint = '#1baca6'; onGrade = '#1c1a18'
}
function Get-Ink($key) { [System.Drawing.ColorTranslator]::FromHtml($script:ink[$key]) }

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'
$form.Location        = New-Object System.Drawing.Point($X, $Y)
$form.Size            = New-Object System.Drawing.Size($W, $H)
$form.TopMost         = $true
$form.ShowInTaskbar   = $false
$form.BackColor       = Get-Ink 'bg'
$form.Opacity         = 0.96

# Rounded, like every other surface this product draws. A borderless form is a
# rectangle until it is given a region, and the region is the only way to round
# one without owner-drawing the whole window.
function Set-RoundedRegion($ctl, [int]$radius) {
  $d = $radius * 2
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($ctl.Width - $d - 1, 0, $d, $d, 270, 90)
  $p.AddArc($ctl.Width - $d - 1, $ctl.Height - $d - 1, $d, $d, 0, 90)
  $p.AddArc(0, $ctl.Height - $d - 1, $d, $d, 90, 90)
  $p.CloseFigure()
  $ctl.Region = New-Object System.Drawing.Region($p)
}
Set-RoundedRegion $form 10

# The grade badge: a solid round chip carrying the annotation mark, in the dark
# ink the design system specifies. White on these fills runs 1.6:1 to 3.4:1.
$script:badgeColor = $null
$script:badgeGlyph = ''
$badge = New-Object System.Windows.Forms.Panel
$badge.Size     = New-Object System.Drawing.Size(36, 36)
$badge.Location = New-Object System.Drawing.Point($PAD, 16)
$badge.BackColor = Get-Ink 'bg'
$badge.Add_Paint({
  param($s, $e)
  if (-not $script:badgeColor) { return }
  $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $brush = New-Object System.Drawing.SolidBrush $script:badgeColor
  $e.Graphics.FillEllipse($brush, 0, 0, 35, 35)
  $brush.Dispose()
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $ink = New-Object System.Drawing.SolidBrush (Get-Ink 'onGrade')
  $rect = New-Object System.Drawing.RectangleF 0, 0, 36, 36
  $e.Graphics.DrawString($script:badgeGlyph, $fontBadge, $ink, $rect, $fmt)
  $ink.Dispose(); $fmt.Dispose()
})
$form.Controls.Add($badge)

$lblVerdict = New-Object System.Windows.Forms.Label
$lblVerdict.Font      = $fontVerdict
$lblVerdict.ForeColor = Get-Ink 'verdict'
$lblVerdict.Location  = New-Object System.Drawing.Point($PAD, 18)
$lblVerdict.Size      = New-Object System.Drawing.Size(150, 32)
$lblVerdict.Text      = 'Waiting for a move...'
$form.Controls.Add($lblVerdict)

# The move and the engine's numbers, right-aligned against the padding, so the
# grade name on the left can grow without the two colliding. The column starts
# where the longest grade name ("Inaccuracy") ends: the engine line is the
# widest thing here and gets whatever is left, because a right-aligned label
# that overflows loses its left end rather than its right, and the left end is
# the score you had before the move.
$EVAL_X = 214
$lblSan = New-Object System.Windows.Forms.Label
$lblSan.Font      = $fontSan
$lblSan.ForeColor = Get-Ink 'verdict'
$lblSan.TextAlign = 'MiddleRight'
$lblSan.Location  = New-Object System.Drawing.Point($EVAL_X, 18)
$lblSan.Size      = New-Object System.Drawing.Size(($W - $EVAL_X - $PAD), 18)
$form.Controls.Add($lblSan)

$lblEval = New-Object System.Windows.Forms.Label
$lblEval.Font      = $fontEval
$lblEval.ForeColor = Get-Ink 'eval'
$lblEval.TextAlign = 'MiddleRight'
$lblEval.Location  = New-Object System.Drawing.Point($EVAL_X, 36)
$lblEval.Size      = New-Object System.Drawing.Size(($W - $EVAL_X - $PAD), 16)
$form.Controls.Add($lblEval)

$lblWhy = New-Object System.Windows.Forms.Label
$lblWhy.Font      = $fontWhy
$lblWhy.ForeColor = Get-Ink 'why'
$lblWhy.Location  = New-Object System.Drawing.Point($PAD, 62)
$lblWhy.Size      = New-Object System.Drawing.Size(($W - $PAD * 2), 48)
$form.Controls.Add($lblWhy)

# A hairline above the hint, so the ladder reads as a separate answer rather
# than as a fourth sentence about the move.
$rule = New-Object System.Windows.Forms.Panel
$rule.Location  = New-Object System.Drawing.Point($PAD, 116)
$rule.Size      = New-Object System.Drawing.Size(($W - $PAD * 2), 1)
$rule.BackColor = [System.Drawing.Color]::FromArgb(38, 255, 255, 255)
$form.Controls.Add($rule)

# The suggestion ladder. Its own line and its own colour, so asking for a hint
# never overwrites the verdict of the move you just played.
$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Font      = $fontHint
$lblHint.ForeColor = Get-Ink 'hint'
$lblHint.Location  = New-Object System.Drawing.Point($PAD, 128)
$lblHint.Size      = New-Object System.Drawing.Size(($W - $PAD * 2), 36)
$form.Controls.Add($lblHint)

# Drag the window by its body, since it has no title bar.
$script:drag = $false; $script:dragOrigin = [System.Drawing.Point]::Empty
$onDown = { param($s, $e) $script:drag = $true; $script:dragOrigin = $e.Location }
$onMove = {
  param($s, $e)
  if (-not $script:drag) { return }
  $form.Location = New-Object System.Drawing.Point `
    (($form.Location.X + $e.X - $script:dragOrigin.X)), `
    (($form.Location.Y + $e.Y - $script:dragOrigin.Y))
}
$onUp = { $script:drag = $false }

# t / w / c ask the coach a question: his threat, your weaknesses, whether this
# move matters. The letter itself is handed over, so adding a topic on the Node
# side needs no change here.
#
# This window is TopMost and shown with ShowDialog, so it takes the keyboard the
# moment it appears and the terminal stops receiving keys. Rather than wrestling
# focus back — which would mean SetWindowPos through P/Invoke, and this project
# deliberately compiles no native code — the key is simply read here too, and
# handed to Node the same way state comes the other way: through a file.
$coachKeys = @{
  [System.Windows.Forms.Keys]::T = 't'
  [System.Windows.Forms.Keys]::W = 'w'
  [System.Windows.Forms.Keys]::C = 'c'
}
$form.KeyPreview = $true
$form.Add_KeyDown({
  param($s, $e)
  if (-not $HintFile -or -not $coachKeys.ContainsKey($e.KeyCode)) { return }
  try { [IO.File]::WriteAllText($HintFile, $coachKeys[$e.KeyCode]) } catch { }
})
# Every control, or the strip it covers stops being draggable. The rule is one
# pixel high and the badge is a hole in the middle of the grab area, so both
# matter more than their size suggests.
foreach ($c in @($form, $badge, $lblVerdict, $lblSan, $lblEval, $lblWhy, $rule, $lblHint)) {
  $c.Add_MouseDown($onDown); $c.Add_MouseMove($onMove); $c.Add_MouseUp($onUp)
}

function Set-Ink($s) {
  if (-not $s.ink) { return }
  foreach ($k in @('bg', 'verdict', 'eval', 'why', 'hint', 'onGrade')) {
    if ($s.ink.$k) { $script:ink[$k] = $s.ink.$k }
  }
  $form.BackColor  = Get-Ink 'bg'
  $badge.BackColor = Get-Ink 'bg'
  $lblEval.ForeColor = Get-Ink 'eval'
  $lblWhy.ForeColor  = Get-Ink 'why'
  $lblHint.ForeColor = Get-Ink 'hint'
}

function Set-State($s) {
  if ($s.quit) { $form.Close(); return }
  Set-Ink $s

  # No glyph means no graded move — a status line, or the wait before the first
  # one. The badge is hidden rather than drawn empty.
  if ($s.glyph) {
    $script:badgeGlyph = $s.glyph
    $script:badgeColor = if ($s.color) {
      [System.Drawing.ColorTranslator]::FromHtml($s.color)
    } else { Get-Ink 'verdict' }
    $badge.Visible = $true
    $lblVerdict.Location = New-Object System.Drawing.Point(($PAD + 46), 18)
    $lblVerdict.Text = $s.label
    $lblVerdict.ForeColor = $script:badgeColor
  } else {
    $script:badgeColor = $null
    $badge.Visible = $false
    $lblVerdict.Location = New-Object System.Drawing.Point($PAD, 18)
    $lblVerdict.Text = $s.label
    $lblVerdict.ForeColor = Get-Ink 'verdict'
  }
  $badge.Invalidate()

  $lblSan.Text  = $s.san
  $lblEval.Text = $s.eval
  $lblWhy.Text  = $s.why
  $lblHint.Text = $s.hint
  $rule.Visible = [bool]$s.hint
}

$script:lastWrite = [DateTime]::MinValue
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  try {
    if (-not (Test-Path $StateFile)) { return }
    $w = (Get-Item $StateFile).LastWriteTimeUtc
    if ($w -le $script:lastWrite) { return }
    $script:lastWrite = $w
    # -Encoding UTF8 is not optional: Node writes UTF-8 without a BOM, and
    # Windows PowerShell 5.1 falls back to the ANSI codepage when there is no
    # BOM, which turns the label glyphs into mojibake (star -> "a~...").
    Set-State (Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json)
  } catch {
    # A torn read or transient lock is not worth killing the overlay over;
    # the next tick will pick up the same file.
  }
})
$timer.Start()

[void]$form.ShowDialog()
$timer.Stop()
