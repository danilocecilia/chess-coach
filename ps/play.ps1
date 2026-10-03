<#
  Play an MP3 file and exit.

  Used by src/audio.js for voice coaching playback. Spawned as a child process
  so it can be killed mid-sentence when a higher-priority utterance arrives —
  killing the process stops the sound immediately, which is the whole mechanism
  behind "a blunder interrupts a hint".

  WPF's MediaPlayer is in PresentationCore, present on every Windows 10/11
  install. It plays MP3 natively, needs no COM and no native binary.
#>

param(
  [Parameter(Mandatory = $true)][string]$AudioPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore

$p = New-Object System.Windows.Media.MediaPlayer
$resolved = (Resolve-Path $AudioPath).Path.Replace('\', '/')
$p.Open([uri]::new("file:///$resolved"))

# Let the media load before starting playback.
Start-Sleep -Milliseconds 300
$p.Play()

# Wait for the duration to become known (up to 3s).
for ($i = 0; $i -lt 30 -and -not $p.NaturalDuration.HasTimeSpan; $i++) {
  Start-Sleep -Milliseconds 100
}

# Wait for playback to finish (up to 30s safety cap).
if ($p.NaturalDuration.HasTimeSpan) {
  $end = $p.NaturalDuration.TimeSpan
  for ($i = 0; $i -lt 150 -and $p.Position -lt $end; $i++) {
    Start-Sleep -Milliseconds 200
  }
}

$p.Close()
