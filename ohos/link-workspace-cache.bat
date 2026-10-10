@echo off
set CACHE=C:\Users\darny\.hvigor\project_caches
set SRC=%CACHE%\e58d2021fc4064e555ff1431e718b15e\workspace
set DST=%CACHE%\3a141b496ff1acc66b60952602201633\workspace

if not exist "%CACHE%\3a141b496ff1acc66b60952602201633" mkdir "%CACHE%\3a141b496ff1acc66b60952602201633"

if exist "%DST%" (
  echo [skip] already exists: %DST%
) else (
  mklink /J "%DST%" "%SRC%"
  if errorlevel 1 (
    echo [fail] mklink failed
    exit /b 1
  )
  echo [ok] created junction
)

dir "%CACHE%\3a141b496ff1acc66b60952602201633"
