# PowerShell vs CMD Reference

## Mental model

| Dimension | PowerShell | CMD / Batch |
|-----------|------------|-------------|
| Unit of data | .NET objects | Text strings |
| Pipeline | Passes objects | Passes text lines |
| Commands | Cmdlets + functions + aliases | Internal commands + external executables |
| Extensibility | Modules, .NET, COM, REST | Limited; call external tools |
| Script extension | `.ps1` | `.bat` or `.cmd` |
| Default shell | `powershell.exe` (5.1) / `pwsh.exe` (7+) | `cmd.exe` |

## When to choose which

Use **PowerShell** when you need:

- Structured data, JSON, XML, CSV handling.
- System administration (services, registry, event logs, AD, WMI/CIM).
- .NET Framework / .NET Core integration.
- Cross-platform compatibility (PowerShell 7 runs on Windows, macOS, Linux).
- Reusable modules and functions.

Use **CMD / Batch** when:

- You are on a very minimal Windows environment without PowerShell (rare today).
- You are maintaining legacy `.bat` files.
- You need the smallest possible runtime dependency and startup time.
- You are writing a wrapper that must work before PowerShell is available.

## Common command translations

| Task | PowerShell | CMD |
|------|------------|-----|
| List directory | `Get-ChildItem` | `DIR` or `dir` |
| Change directory | `Set-Location C:\temp` | `cd C:\temp` |
| Print working directory | `(Get-Location).Path` | `cd` |
| Copy file | `Copy-Item src.txt dst.txt` | `copy src.txt dst.txt` |
| Move file | `Move-Item src.txt dst\` | `move src.txt dst\` |
| Delete file | `Remove-Item file.txt` | `del file.txt` |
| Delete directory recursively | `Remove-Item -Recurse -Force dir` | `rmdir /S /Q dir` |
| Find string in file | `Select-String -Path file.txt -Pattern 'foo'` | `findstr "foo" file.txt` |
| List running processes | `Get-Process` | `tasklist` |
| Kill process | `Stop-Process -Name notepad` | `taskkill /IM notepad.exe /F` |
| Service status | `Get-Service -Name Spooler` | `sc query Spooler` |
| Environment variable | `$env:PATH` | `echo %PATH%` |
| Test network | `Test-Connection 8.8.8.8` | `ping 8.8.8.8` |
| Redirect stdout | `command > file.txt` | `command > file.txt` |
| Append stdout | `command >> file.txt` | `command >> file.txt` |

## Quoting and escaping

### PowerShell

- Single quotes `'...'` = literal string.
- Double quotes `"..."` = expandable string, allows `$variables` and subexpressions `$(...)`.
- Backtick `` ` `` is the escape character.
- To pass a literal `"` to an external program, double the quotes or use `""`.

```powershell
"Value is $x"
'Value is $x'        # literal
"Path: C:\\temp"    # backslash does not need escaping inside quotes, except before special chars
`"hello`"            # escaped double quote
```

### CMD

- Double quotes `"..."` are the standard quoting mechanism.
- `%` is special; use `%%` inside batch files.
- `^` is the escape character.
- Delayed expansion (`setlocal enabledelayedexpansion`) is needed for variables set inside blocks.

```batch
echo "hello world"
echo %%PATH%%
echo This is a caret ^& ampersand
setlocal enabledelayedexpansion
set "x=5"
echo !x!
```

## Path handling

### PowerShell

```powershell
# Always safe for spaces
$path = Join-Path -Path 'C:\Program Files' -ChildPath 'MyApp\app.exe'

# Test path existence
Test-Path -Path 'C:\My Data\file.txt'

# Split path
Split-Path -Path 'C:\temp\file.txt' -Parent    # C:\temp
Split-Path -Path 'C:\temp\file.txt' -Leaf       # file.txt
```

### CMD

```batch
set "filepath=C:\Program Files\MyApp\app.exe"
echo %filepath%
if exist "%filepath%" echo exists
```

## Variables

### PowerShell

```powershell
$name = 'World'
$greeting = "Hello, $name"
$greeting = 'Hello, {0}' -f $name
```

### CMD

```batch
set "name=World"
echo Hello, %name%
setlocal enabledelayedexpansion
echo Hello, !name!
```

## Conditionals and loops

### PowerShell

```powershell
if ($x -gt 10) { Write-Host 'big' } else { Write-Host 'small' }

foreach ($file in Get-ChildItem -Path 'C:\temp') {
    Write-Host $file.Name
}

1..5 | ForEach-Object { $_ * 2 }
```

### CMD

```batch
if %x% gtr 10 (
    echo big
) else (
    echo small
)

for %%f in (C:\temp\*) do echo %%f

for /L %%i in (1,1,5) do @echo %%i
```

## Error handling

### PowerShell

- `$ErrorActionPreference` controls default behavior.
- Use `-ErrorAction` per cmdlet.
- Use `try/catch/finally`.

```powershell
$ErrorActionPreference = 'Stop'
try {
    Get-Content missing.txt
} catch {
    Write-Error "Failed: $_"
}
```

### CMD

- `%ERRORLEVEL%` holds the exit code of the last command.
- `&&` = run next if previous succeeded.
- `||` = run next if previous failed.

```batch
somecommand.exe
if %errorlevel% neq 0 (
    echo failed
    exit /b %errorlevel%
)
```

## Pitfalls when moving between shells

1. **Case sensitivity**: PowerShell cmdlets are case-insensitive. CMD is mostly case-insensitive too, but external tools may not be.
2. **`$` vs `%`**: PowerShell variables use `$`; CMD uses `%`.
3. **Null / empty**: PowerShell has `$null`; CMD empty string is `""`.
4. **Boolean**: PowerShell uses `$true`/`$false`; CMD has no native boolean.
5. **Comments**: PowerShell uses `#`. CMD uses `REM` or `::` (inside blocks `::` can fail, prefer `REM`).


## Encoding boundaries across PowerShell, CMD, and native tools

PowerShell's object pipeline is not the same as a native text pipeline. Encoding becomes relevant when text crosses a byte-oriented boundary.

| Boundary | Main concern |
|---|---|
| PowerShell object -> PowerShell object | Normally Unicode/.NET objects; no legacy code page is needed |
| File -> PowerShell string | Decode using the file's actual encoding |
| PowerShell string -> file | Encode using the required/preserved file encoding |
| PowerShell -> native stdin | Controlled by `$OutputEncoding` |
| Native stdout/stderr -> PowerShell | Depends on the native program and host/PowerShell decoding behavior |
| CMD/`.bat` console text | Active console/OEM code-page behavior matters |
| `chcp` | Changes active console code page, not file encoding |

Before changing a console code page, check whether the problem is really the console. A UTF-8 file, CP932 native tool, and CP936 Windows locale can coexist.

For detailed rules and East Asian code-page examples, load `windows-text-encoding.md`.
