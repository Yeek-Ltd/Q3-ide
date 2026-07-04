@echo off
set CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.0
set PATH=%CUDA_PATH%\bin;%PATH%
set CUDA_PATH_V13_0=%CUDA_PATH%

call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"

set BUILD_DIR=C:\Users\Ceete\.q3ide\ik_llama_cpp\build
if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"
cd /d "%BUILD_DIR%"

cmake .. -G "Visual Studio 17 2022" -A x64 ^
    -DCMAKE_BUILD_TYPE=Release ^
    -DGGML_CUDA=ON ^
    -DGGML_CUDA_USE_TENSOR_CORES=ON ^
    -DGGML_CUDA_F16=ON ^
    -DGGML_FLASH_ATTN=ON ^
    -DLLAMA_CURL=OFF ^
    -DGGML_NATIVE=ON ^
    -DCMAKE_CUDA_ARCHITECTURES=89

cmake --build . --config Release -j %NUMBER_OF_PROCESSORS% --target llama-server

echo.
echo Build complete. Exit code: %ERRORLEVEL%
echo Binary: %BUILD_DIR%\bin\Release\llama-server.exe
