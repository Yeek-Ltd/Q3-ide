$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'C:\Users\Ceete\.q3ide\llamacpp\llama-server.exe'
$psi.Arguments = '--help'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $false

$proc = [System.Diagnostics.Process]::Start($psi)
$stdout = $proc.StandardOutput.ReadToEnd()
$stderr = $proc.StandardError.ReadToEnd()
$proc.WaitForExit(10000)

Write-Host "Exit code: $($proc.ExitCode)"
Write-Host "STDOUT: $stdout"
Write-Host "STDERR: $stderr"
