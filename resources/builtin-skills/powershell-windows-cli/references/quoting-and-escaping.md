# Quoting and Escaping Across Windows Shell Boundaries

Use this reference when arguments contain spaces, quotes, JSON, non-ASCII text, shell metacharacters, nested shells, or user-provided values.

The preferred solution is usually to remove parser layers, not to invent more escapes.

## PowerShell string rules

Single-quoted strings are literal:

```powershell
'$name'
```

Double-quoted strings expand variables and subexpressions:

```powershell
"Hello $name"
"Today: $(Get-Date)"
```

PowerShell's escape character is the backtick, not backslash.

Do not add backslashes to ordinary Windows paths merely because another language would need escaping:

```powershell
'C:\Program Files\My App'
```

is a normal PowerShell string. The backslashes are literal characters.

## Prefer variables over nested quote gymnastics

Avoid embedding complex values directly into command text:

```powershell
& tool.exe "--payload={\"name\":\"$name\"}"
```

Prefer constructing the value first:

```powershell
$json = @{
    name = $name
} | ConvertTo-Json -Compress

& tool.exe @('--payload', $json)
```

This separates data construction from command parsing.

## Native executable arguments

For direct native invocation, pass values as separate PowerShell arguments:

```powershell
$args = @(
    '--input'
    $path
    '--name'
    $displayName
)

& $exe @args
```

Do not build:

```powershell
$line = "$exe --input `"$path`" --name `"$displayName`""
Invoke-Expression $line
```

## PowerShell 7.3+ behavior matters

PowerShell 7.3 introduced `$PSNativeCommandArgumentPassing` because native quoting behavior changed.

On Windows the default is `Windows`, which uses modern behavior for most executables but intentionally falls back to legacy parsing for `cmd.exe`, batch files, and several legacy script hosts/tools.

When debugging argument corruption, inspect:

```powershell
$PSVersionTable.PSVersion
$PSNativeCommandArgumentPassing
```

Do not blindly paste a PowerShell 7.4 quoting workaround into Windows PowerShell 5.1.

## Start-Process requires its own quoting

`Start-Process -ArgumentList` is not equivalent to a true argv array. Array elements are joined into one string.

If process-control behavior is required, either:

- provide one carefully quoted argument string that matches the target parser; or
- on a compatible modern .NET runtime, use `ProcessStartInfo.ArgumentList` after feature detection.

Do not advertise `Start-Process -ArgumentList @(...)` as automatically quote-safe.

## CMD parser boundary

CMD uses a different grammar:

- double quotes group many arguments;
- single quotes are not PowerShell-style string delimiters;
- `^` escapes many CMD metacharacters;
- `%` expands environment/batch variables;
- `!` expands delayed variables when delayed expansion is enabled;
- `& | < > ( )` can control command structure.

If PowerShell constructs a string for `cmd /c`, the text can be parsed once by PowerShell and again by CMD.

Avoid this for ordinary executables.

## Batch files

A `.bat` or `.cmd` file is not an argv-safe transport for arbitrary untrusted text.

Dynamic values containing characters meaningful to CMD can change interpretation after PowerShell has already passed them onward.

If arbitrary user text must cross this boundary, prefer:

- a temporary file;
- stdin;
- an environment-independent structured API;
- a direct executable with separate arguments;

when supported by the target.

## Stop-parsing token

`--%` can reduce escaping for static Windows native syntax:

```powershell
icacls X:\VMS --% /grant Dom\HVAdmin:(CI)(OI)F
```

Do not expect normal PowerShell variables, subexpressions, semicolons, line continuation, or redirection behavior after `--%`.

If you need dynamic composition, use ordinary argument values instead.

## Nested pwsh / powershell.exe

Avoid multiple quoting languages in one line.

Prefer:

```powershell
pwsh -NoProfile -File .\script.ps1 -InputPath $path
```

over:

```powershell
pwsh -Command "& { ... '$path' ... }"
```

for reusable or complex work.

If you control both sides, define script parameters and let PowerShell bind them instead of serializing everything into source text.

## JSON

Recommended order:

1. create the object;
2. serialize it with `ConvertTo-Json`;
3. pass the resulting JSON as one argument, stdin, or file according to the target contract.

```powershell
$json = $payload | ConvertTo-Json -Compress
& tool.exe @('--json', $json)
```

Avoid manual JSON escaping inside CMD strings or nested PowerShell source strings.

## Paths ending in backslash

PowerShell itself does not use backslash as its escape character, but a target native argument parser can have special quote/backslash rules.

When a quoted native argument ends in backslash and must retain literal quote characters, verify the target executable's parser and the current PowerShell native argument mode. Do not apply a universal "double every backslash" rule.

## Diagnostic strategy

When quoting fails:

1. identify every parser in order;
2. remove unnecessary parsers;
3. reduce to one problematic argument;
4. inspect PowerShell version and `$PSNativeCommandArgumentPassing`;
5. test the target with an argument-dump helper if available;
6. only then add parser-specific escaping.

PowerShell 7.3+ can trace native parameter binding with `Trace-Command`, which is useful when diagnosing what PowerShell sends to a native executable.
