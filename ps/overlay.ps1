<#
  Always-on-top verdict overlay.

  State arrives via a JSON file rather than stdin: a WinForms message loop and a
  blocking Console.In.ReadLine() cannot coexist without freezing the UI, and
  polling a small file every 100ms is both simpler and impossible to deadlock.
  Node writes that file atomically, so a half-written read is not possible.

  The window is click-through-free and draggable, so it can be parked anywhere.
#>

param(
  [Parameter(Mandatory = $true)][string]$StateFile,
  [string]$HintFile,
  [int]$X = 40, [int]$Y = 40
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'
$form.Location        = New-Object System.Drawing.Point($X, $Y)
$form.Size            = New-Object System.Drawing.Size(430, 168)
$form.TopMost         = $true
$form.ShowInTaskbar   = $false
$form.BackColor       = [System.Drawing.Color]::FromArgb(22, 21, 18)
$form.Opacity         = 0.94

$lblVerdict = New-Object System.Windows.Forms.Label
$lblVerdict.Font      = New-Object System.Drawing.Font 'Segoe UI Semibold', 21
$lblVerdict.ForeColor = [System.Drawing.Color]::White
$lblVerdict.Location  = New-Object System.Drawing.Point(18, 12)
$lblVerdict.Size      = New-Object System.Drawing.Size(394, 36)
$lblVerdict.Text      = 'Waiting for a move...'
$form.Controls.Add($lblVerdict)

$lblEval = New-Object System.Windows.Forms.Label
$lblEval.Font      = New-Object System.Drawing.Font 'Consolas', 10
$lblEval.ForeColor = [System.Drawing.Color]::FromArgb(150, 148, 140)
$lblEval.Location  = New-Object System.Drawing.Point(20, 50)
$lblEval.Size      = New-Object System.Drawing.Size(394, 18)
$form.Controls.Add($lblEval)

$lblWhy = New-Object System.Windows.Forms.Label
$lblWhy.Font      = New-Object System.Drawing.Font 'Segoe UI', 10
$lblWhy.ForeColor = [System.Drawing.Color]::FromArgb(206, 203, 194)
$lblWhy.Location  = New-Object System.Drawing.Point(20, 72)
$lblWhy.Size      = New-Object System.Drawing.Size(394, 50)
$form.Controls.Add($lblWhy)

# The suggestion ladder. Its own line and its own colour, so asking for a hint
# never overwrites the verdict of the move you just played.
$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Font      = New-Object System.Drawing.Font 'Segoe UI Semibold', 10
$lblHint.ForeColor = [System.Drawing.Color]::FromArgb(27, 172, 166)
$lblHint.Location  = New-Object System.Drawing.Point(20, 124)
$lblHint.Size      = New-Object System.Drawing.Size(394, 34)
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
foreach ($c in @($form, $lblVerdict, $lblEval, $lblWhy, $lblHint)) {
  $c.Add_MouseDown($onDown); $c.Add_MouseMove($onMove); $c.Add_MouseUp($onUp)
}

function Set-State($s) {
  if ($s.quit) { $form.Close(); return }

  $lblVerdict.Text = if ($s.glyph) { "$($s.san)   $($s.label) $($s.glyph)" } else { $s.label }
  $lblVerdict.ForeColor = if ($s.color) {
    [System.Drawing.ColorTranslator]::FromHtml($s.color)
  } else { [System.Drawing.Color]::White }

  $lblEval.Text = $s.eval
  $lblWhy.Text  = $s.why
  $lblHint.Text = $s.hint
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
