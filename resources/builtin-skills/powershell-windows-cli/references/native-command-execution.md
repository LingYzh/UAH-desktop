# Native Command Execution from PowerShell

Use this reference when PowerShell launches `.exe`, `.cmd`, `.bat`, package managers, compilers, Git, Python, Node, .NET tools, or another shell.

## First identify the boundary

Before choosing syntax, classify the target:

- PowerShell cmdlet/function/script;
- native executable;
- `cmd.exe` built-in or batch file;
- nested `pwsh` / `powershell.exe`;
- script host such as `cscript.exe` / `wscript.exe`.

Every extra shell layer adds another parser and may add another encoding boundary. Avoid layers that are not required.

## Prefer direct native invocation

For ordinary executables, prefer separate PowerShell arguments:

```powershell
$gitArgs = @(
    'commit'
    '-m'
    $message
)

& git @gitArgs

if ($LASTEXITCODE -ne 0) {
    throw "git failed with exit code $LASTEXITCODE"
}
```

Do not build one executable command string and feed it to `Invoke-Expression`.

Direct invocation is especially valuable for values containing spaces, non-ASCII text, JSON, quotes, or shell metacharacters.

## PowerShell 7.3 native argument passing

PowerShell 7.3 changed native argument passing and introduced:

```powershell
$PSNativeCommandArgumentPassing
```

Valid modes:

- `Legacy`: historical behavior;
- `Standard`: newer argument-passing behavior;
- `Windows`: Windows default.

On Windows, `Windows` behaves like `Standard` for most native executables but uses `Legacy` behavior for compatibility when invoking targets such as `cmd.exe`, `cscript.exe`, `wscript.exe`, `find.exe`, `sqlcmd.exe`, and files ending in `.bat`, `.cmd`, `.js`, `.vbs`, or `.wsf`.

Do not globally force `Legacy` or `Standard` just to fix one command. If an override is truly required, scope it narrowly and restore it.

Windows PowerShell 5.1 predates these modes and uses legacy native argument behavior. Complex quoting that works in PowerShell 7.3+ may need different handling in 5.1.

## Start-Process is process control, not argv preservation

`Start-Process -ArgumentList` accepts an array, but PowerShell joins those elements into one command-line string before starting the process.

Therefore do not use this as the default "safe argument array" pattern:

```powershell
Start-Process -FilePath 'tool.exe' -ArgumentList '--name', $value
```

If `$value` contains spaces or quotes, quoting must still match the target parser.

Use `Start-Process` when you actually need its process-control features:

- `-Verb RunAs` / elevation;
- credentials;
- a new window;
- waiting;
- standard-stream redirection;
- environment/process-start options.

For direct command execution, `& $exe @args` is normally clearer.

On modern .NET runtimes, `System.Diagnostics.ProcessStartInfo.ArgumentList` is a distinct structured argument collection that escapes arguments when creating the final command line. Feature-detect it; Windows PowerShell 5.1's .NET Framework environment should not be assumed to provide it.

## CMD and batch are string boundaries

On Windows, parameters passed to batch files are ultimately passed as raw command-line strings to `cmd.exe`.

This means:

- PowerShell parsing happens first;
- CMD parsing may happen second;
- `%`, `!`, `^`, `&`, `|`, `<`, `>`, parentheses and quotes can gain new meanings;
- delayed expansion can introduce yet another interpretation of `!`.

Do not route ordinary executable calls through `cmd /c`:

```powershell
# Avoid
cmd /c "git status --short"

# Prefer
& git @('status', '--short')
```

Use `cmd /c` only when CMD semantics are actually required.

For untrusted or complex dynamic values, avoid batch/CMD string boundaries when a structured executable/API alternative exists.

## Stop-parsing token --%

The Windows-only stop-parsing token is useful for mostly static native syntax that PowerShell would otherwise interpret.

```powershell
icacls X:\VMS --% /grant Dom\HVAdmin:(CI)(OI)F
```

After `--%`, PowerShell treats the rest of that command mostly literally. Normal PowerShell variables and subexpressions are not a practical dynamic-composition mechanism there.

Important limitations:

- scope ends at newline or pipeline;
- PowerShell line continuation does not extend it;
- ordinary PowerShell stream redirection after it is passed to the native tool rather than interpreted normally;
- only Windows-style `%ENVVAR%` substitution is specially supported.

Use it as an escape hatch for static syntax, not as the default native invocation style.

## The -- token is different

PowerShell's end-of-parameters token `--` applies to PowerShell commands.

When used with an external executable, `--` is simply passed to that executable. Whether it has meaning depends on the target program.

Do not confuse `--` with `--%`.

## JSON and complex text arguments

Prefer a single explicit boundary.

Example:

```powershell
$json = $payload | ConvertTo-Json -Compress

$args = @(
    '--payload'
    $json
)

& tool.exe @args
```

If the target supports stdin or an input file, those can be more robust for large JSON/documents than multi-layer shell quoting.

Do not manually build strings such as:

```powershell
cmd /c "tool.exe --payload \"{...}\""
```

unless CMD is genuinely required and the quoting has been verified for that exact target.

## Nested PowerShell

For reusable or multi-line work, prefer a script file with parameters:

```powershell
pwsh -NoProfile -File .\task.ps1 -Name $name
```

rather than embedding a large dynamically constructed `pwsh -Command "..."` string.

Every nested `-Command` adds another PowerShell parser and another round of quote/interpolation decisions.

For one short trusted command, `-Command` can be reasonable. Do not turn it into the default transport for complex dynamic data.

## Native exit codes

`$ErrorActionPreference = 'Stop'` is not a universal substitute for native exit-code handling.

```powershell
& tool.exe @args
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    throw "tool.exe failed with exit code $exitCode"
}
```

But interpret exit codes using the target tool's contract. Some tools use nonzero codes for informational or successful states. `robocopy` is a common Windows example.

PowerShell also provides `$PSNativeCommandUseErrorActionPreference` in modern versions. If you temporarily change it for a tool with unusual exit-code semantics, scope the change narrowly.

## Native stdin encoding

PowerShell uses `$OutputEncoding` when piping text into native applications.

```powershell
$oldOutputEncoding = $OutputEncoding

try {
    $OutputEncoding = [System.Text.Encoding]::GetEncoding(936)
    $text | legacy-tool.exe
}
finally {
    $OutputEncoding = $oldOutputEncoding
}
```

Choose the encoding because the target program requires it, not because of Windows language.

## Native stdout/stderr and binary streams

Native programs may emit UTF-8, a legacy Windows code page, or a tool-specific encoding. Do not assume `$OutputEncoding` controls native stdout decoding; it controls PowerShell -> native stdin.

PowerShell 7.4+ preserves raw byte-stream data when native stdout is redirected directly to a file or when native byte-stream output is piped to another native command. This matters for binary payloads such as archives.

Do not apply text encoding conversions to a byte-stream pipeline unless the data is actually text.

## Destructive native commands

For native tools:

1. use the tool's own dry-run/preview flag when available;
2. otherwise inspect the exact target set;
3. require confirmation when the destructive action is not already clearly authorized;
4. never append PowerShell `-WhatIf` mechanically to a native executable.

## Related references

- `quoting-and-escaping.md` for parser-specific quoting and JSON/nested-shell patterns.
- `windows-text-encoding.md` for code pages, BOM, console and file boundaries.
- `powershell-vs-cmd.md` for shell-selection differences.
- `common-pitfalls.md` for recurring Windows shell mistakes.
