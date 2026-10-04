# Common Pitfalls and Fixes

## PowerShell

### 1. Execution policy blocks scripts

**Symptom**: `cannot be loaded because running scripts is disabled on this system`

**Fixes**:

```powershell
# Check current policy
Get-ExecutionPolicy -List

# Run a single script with bypass (does not change policy; prefer pwsh on PS 7)
pwsh -ExecutionPolicy Bypass -File C:\scripts\myscript.ps1
# Fallback for Windows PowerShell 5.1-only systems:
# powershell -ExecutionPolicy Bypass -File C:\scripts\myscript.ps1

# Set user-scope policy (less risky than machine-scope)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Do not recommend `Unrestricted` as a default.

### 2. `$null` on the left side of comparisons

```powershell
# WRONG: can return unexpected results with collections
if ($myArray -eq $null) { ... }

# RIGHT
if ($null -eq $myArray) { ... }
```

### 3. Using `Invoke-Expression` on untrusted input

**Risk**: command injection.

**Fix**: use argument lists or parameterized calls instead.

```powershell
# Risky
Invoke-Expression "Get-Process -Name $name"

# Safer
Get-Process -Name $name

# For a directly invokable native program, keep arguments separate.
$nativeArgs = @(
    '--input'
    $userInput
)

& 'myapp.exe' @nativeArgs
```

### 4. Aliases in scripts

**Fix**: use full cmdlet names in scripts that will be shared or reused.

```powershell
# Avoid in scripts
ls | ?{ $_.Length -gt 1MB }

# Prefer
Get-ChildItem | Where-Object { $_.Length -gt 1MB }
```

### 5. Accidental string interpolation in file paths

```powershell
# If $env:TEMP contains backslashes, this is usually fine,
# but user-supplied paths should be validated.
$path = Join-Path -Path $env:TEMP -ChildPath 'log.txt'
```

### 6. `Write-Host` vs `Write-Output`

- `Write-Output` sends to the pipeline (use this for returning data).
- `Write-Host` writes to the console only and bypasses the pipeline.

### 7. `-eq` vs `=`

- `-eq` is comparison.
- `=` is assignment.

```powershell
if ($x -eq 5) { ... }   # comparison
$x = 5                   # assignment
```

### 8. Collection enumeration with `ForEach-Object`

```powershell
# Good for pipeline
Get-Process | ForEach-Object { $_.Name }

# Good for arrays
foreach ($proc in Get-Process) { $proc.Name }
```

### 9. String vs number comparison

```powershell
# This is string comparison
'10' -lt '2'    # True (lexicographic)

# Convert first
[int]'10' -lt [int]'2'  # False
```

## CMD / Batch

### 1. Variables inside blocks

**Symptom**: Variables set inside `if` or `for` blocks do not update.

**Fix**: enable delayed expansion.

```batch
setlocal enabledelayedexpansion
for /L %%i in (1,1,5) do (
    set "x=%%i"
    echo !x!
)
```

### 2. Percent signs in batch files

**Symptom**: `Echo is off.` or unexpected output.

**Fix**: double percent signs inside batch files.

```batch
for %%f in (*.txt) do echo %%f
```

### 3. Trailing spaces in `set` assignments

**Symptom**: Extra space in variable value.

**Fix**: use `set "var=value"` syntax.

```batch
set "name=John"
```

### 4. `if exist` with directories

```batch
if exist "C:\MyDir\" (
    echo directory exists
) else (
    echo directory does not exist
)
```

### 5. Escaping special characters

```batch
echo ^&       # prints &
echo ^|       # prints |
echo ^>       # prints >
echo ^^       # prints ^
```

## Cross-shell issues

### 1. Path separators

PowerShell accepts both `/` and `\`. CMD generally requires `\` or quoted paths.

### 2. Single vs double quotes

- PowerShell: single quotes are literal, double quotes expand variables.
- CMD: single quotes have no special meaning; double quotes group arguments.

### 3. Exit codes

- PowerShell: `$LASTEXITCODE` for external programs; `$?` for cmdlet success.
- CMD: `%ERRORLEVEL%`.

### 4. Environment variable persistence

- PowerShell: `[Environment]::SetEnvironmentVariable('NAME', 'value', 'User')` persists.
- CMD: `setx NAME value` persists (but truncates values over 1024 characters).


## Encoding compatibility pitfalls

### Do not assume locale equals encoding

A Windows locale or visible language is only a clue. It does not prove the encoding of a file or native program.

Common East Asian legacy code pages include:

- CP932: Japanese / Shift-JIS family
- CP936: Simplified Chinese legacy Windows text (commonly called GBK in practice)
- CP949: Korean
- CP950: Traditional Chinese / Big5 family
- CP65001: UTF-8

A Simplified Chinese Windows host can still run a CP932 Japanese tool and edit UTF-8 files at the same time.

### PowerShell 5.1 and 7+ differ

Do not treat `-Encoding UTF8` as version-neutral:

- Windows PowerShell 5.1: `UTF8` writes UTF-8 with BOM.
- PowerShell 7+: `utf8` / `utf8NoBOM` are UTF-8 without BOM by default.
- PowerShell 6.2+: registered numeric code-page IDs can be supplied to `-Encoding`.
- PowerShell 7.4+: `-Encoding ansi` maps to the current culture's ANSI code page.

If a `.ps1` must run in Windows PowerShell 5.1 and contains non-ASCII literals, UTF-8 with BOM is usually the safer UTF-8 form.

### Do not use `chcp` as a universal fix

`chcp` changes the active console code page. It does not rewrite file encodings and does not define every native application's protocol. Programs started before a code-page change may continue using the original code page.

Inspect first:

```powershell
$PSVersionTable.PSVersion
[System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage
[System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
[Console]::InputEncoding.CodePage
[Console]::OutputEncoding.CodePage
$OutputEncoding.CodePage
```

### Scope `$OutputEncoding` changes

`$OutputEncoding` controls text PowerShell pipes into native applications. It does not set file encoding.

If a known legacy tool requires a specific stdin code page, change it temporarily and restore it:

```powershell
$oldOutputEncoding = $OutputEncoding

try {
    $OutputEncoding = [System.Text.Encoding]::GetEncoding(936)
    '中文输入' | legacy-tool.exe
}
finally {
    $OutputEncoding = $oldOutputEncoding
}
```

Use the target executable's actual encoding contract. Do not pick CP936 only because the Windows installation is Simplified Chinese.

### Never silently migrate project files

When editing an existing text file:

1. Preserve its current encoding if practical.
2. If the encoding is uncertain, detect or inspect before writing.
3. Treat conversion to UTF-8/another encoding as an explicit migration.
4. Verify that downstream compilers, scripts, services, and legacy tools accept the new encoding.


### Start-Process ArgumentList is not a true argv array

Do not assume this:

```powershell
Start-Process -FilePath 'tool.exe' -ArgumentList '--name', $value
```

preserves two independent argv elements. `Start-Process` joins `ArgumentList` values into one command-line string. If arguments contain spaces or quotes, quoting still has to match the target application's parser.

Use `Start-Process` when its process-control features are needed, such as elevation, credentials, redirection, a new window, or waiting. For ordinary native execution, direct invocation is usually simpler.

On modern .NET runtimes, `System.Diagnostics.ProcessStartInfo.ArgumentList` is a separate API that performs argument escaping. Feature-detect it before use; do not assume the property exists in Windows PowerShell 5.1's .NET Framework runtime.

### Avoid unnecessary cmd /c layers

If an executable can be invoked directly, do this:

```powershell
& git @('status', '--short')
```

rather than:

```powershell
cmd /c "git status --short"
```

Every added shell adds another parser, another quoting grammar, and possibly another encoding boundary.

### Stop-parsing is for static native syntax

The Windows-only `--%` token is useful for native command lines with PowerShell-sensitive punctuation, but after it PowerShell largely stops interpreting the remaining text. Do not use it when you need normal PowerShell variable/subexpression composition.

### Batch files are raw-string boundaries

On Windows, arguments passed to `.bat` or `.cmd` ultimately go through `cmd.exe` raw command-line parsing. Treat dynamic or untrusted arguments as higher risk than direct executable argv-style calls.
