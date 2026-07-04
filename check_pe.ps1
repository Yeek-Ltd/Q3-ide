$bytes = [System.IO.File]::ReadAllBytes('C:\Users\Ceete\.q3ide\llamacpp\llama-server.exe')
$peOffset = [BitConverter]::ToInt32($bytes, 60)
$subsystem = [BitConverter]::ToInt16($bytes, $peOffset + 92)
Write-Host "Subsystem: $subsystem (2=GUI, 3=Console)"
