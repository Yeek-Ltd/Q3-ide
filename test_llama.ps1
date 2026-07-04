try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8081/v1/models' -UseBasicParsing -TimeoutSec 5
    Write-Host $r.Content
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}

Write-Host "---"

try {
    $body = @{
        model = 'qwen3-coder:30b'
        messages = @(@{role='user'; content='Say hello'})
        stream = $false
        max_tokens = 50
    } | ConvertTo-Json -Depth 5
    $r2 = Invoke-WebRequest -Uri 'http://127.0.0.1:8081/v1/chat/completions' -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 30
    Write-Host $r2.Content
} catch {
    Write-Host "Chat Error: $($_.Exception.Message)"
}
