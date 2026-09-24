<#
  Monitor geometry, one JSON object per stdout line:

    {"name":"\\\\.\\DISPLAY1","primary":true,"x":0,"y":0,"w":1920,"h":1080}

  One object per line rather than a JSON array, because Windows PowerShell 5.1's
  ConvertTo-Json collapses a single-element array into a bare object and the
  consumer would have to handle both shapes.

  Coordinates are WinForms virtual-screen coordinates — the same space
  pick-region.ps1 reports and capture.ps1's CopyFromScreen consumes, so a
  rectangle found here can be captured without conversion. A monitor left of or
  above the primary gives negative x/y, which is normal and handled.
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $b = $s.Bounds
  $name = $s.DeviceName | ConvertTo-Json
  $prim = if ($s.Primary) { 'true' } else { 'false' }
  [Console]::Out.WriteLine(
    '{"name":' + $name + ',"primary":' + $prim +
    ',"x":' + $b.X + ',"y":' + $b.Y + ',"w":' + $b.Width + ',"h":' + $b.Height + '}')
}
[Console]::Out.Flush()
