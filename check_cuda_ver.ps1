$dll = 'C:\Users\Ceete\.q3ide\llamacpp\cublas64_13.dll'
$vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($dll)
Write-Host "cublas64_13.dll:"
Write-Host "  FileVersion: $($vi.FileVersion)"
Write-Host "  ProductVersion: $($vi.ProductVersion)"
Write-Host "  ProductName: $($vi.ProductName)"

$dll2 = 'C:\Users\Ceete\.q3ide\llamacpp\cudart64_13.dll'
$vi2 = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($dll2)
Write-Host "`ncudart64_13.dll:"
Write-Host "  FileVersion: $($vi2.FileVersion)"
Write-Host "  ProductVersion: $($vi2.ProductVersion)"

$dll3 = 'C:\Users\Ceete\.q3ide\llamacpp\cublasLt64_13.dll'
$vi3 = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($dll3)
Write-Host "`ncublasLt64_13.dll (copied from Ollama):"
Write-Host "  FileVersion: $($vi3.FileVersion)"
Write-Host "  ProductVersion: $($vi3.ProductVersion)"
