$binaryDir = 'C:\Users\Ceete\.q3ide\llamacpp'
$exe = "$binaryDir\llama-server.exe"
$model = 'C:\Users\Ceete\.q3ide\models\Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL.gguf'

Set-Location $binaryDir

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.Arguments = "--model `"$model`" --ctx-size 4096 --n-gpu-layers 40 --flash-attn on -np 1 --port 8082 --alias qwen3-coder -ctk q8_0 -ctv q8_0 -ot `".ffn_.*_exps.=CPU`""
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $false
$psi.WorkingDirectory = $binaryDir

$proc = [System.Diagnostics.Process]::Start($psi)

# Wait for server to be ready
Write-Host "Waiting for server to load (up to 120s)..."
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) {
        Write-Host "Server exited early with code: $($proc.ExitCode)"
        break
    }
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8082/health' -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) {
            Write-Host "Server ready after $i seconds"
            $ready = $true
            break
        }
    } catch {
        # Still loading
    }
}

if ($ready) {
    Write-Host "`n--- Testing chat request ---"
    try {
        $body = @{
            model = 'qwen3-coder'
            messages = @(
                @{role='system'; content='You are a helpful coding assistant.'},
                @{role='user'; content='Say hello in one sentence.'}
            )
            stream = $false
            max_tokens = 100
        } | ConvertTo-Json -Depth 5
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8082/v1/chat/completions' -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 60
        Write-Host "Response: $($r.Content)"
    } catch {
        Write-Host "Chat Error: $($_.Exception.Message)"
    }
}

Write-Host "`n--- Server status ---"
if ($proc.HasExited) {
    Write-Host "Server EXITED with code: $($proc.ExitCode)"
} else {
    Write-Host "Server still running, killing..."
    $proc.Kill()
}

Start-Sleep -Seconds 2
$proc.WaitForExit(5000) | Out-Null
