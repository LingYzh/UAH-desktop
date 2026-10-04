# Windows Text Encoding Compatibility

Use this reference whenever non-ASCII Windows text crosses a file, script, console, CMD, or native-executable boundary.

## Core mental model

PowerShell/.NET strings are Unicode. Mojibake usually appears when Unicode text is encoded to bytes or bytes are decoded with the wrong encoding.

Never infer encoding solely from:

- visible language or script;
- Windows display language;
- current culture;
- current console code page;
- file extension.

Instead, identify the boundary and the producer/consumer contract.

## Common East Asian legacy code pages

| Code page | Typical legacy use |
| ---: | --- |
| 932 | Japanese, Shift-JIS / Windows-31J family |
| 936 | Simplified Chinese legacy Windows text; commonly treated as GBK-compatible in practice |
| 949 | Korean Unified Hangul Code |
| 950 | Traditional Chinese, Big5 family |
| 65001 | UTF-8 |

These are compatibility defaults, not universal truths. A program may explicitly use UTF-8 regardless of Windows locale.

## Inspect the environment

Use inspection as context, not as proof of a file/program encoding:

```powershell
$PSVersionTable.PSVersion

[System.Globalization.CultureInfo]::CurrentCulture.Name
[System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage
[System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage

[Console]::InputEncoding.EncodingName
[Console]::InputEncoding.CodePage
[Console]::OutputEncoding.EncodingName
[Console]::OutputEncoding.CodePage

$OutputEncoding.EncodingName
$OutputEncoding.CodePage
```

`chcp` can be used to inspect the active console code page, but do not treat its value as the encoding of every file or executable.

## PowerShell 7+ vs Windows PowerShell 5.1

### PowerShell 7+

PowerShell 6+ uses UTF-8 without BOM as the normal text-output default.

PowerShell 6.2+ allows registered numeric code pages:

```powershell
Get-Content .\legacy-gbk.txt -Encoding 936
Get-Content .\legacy-sjis.txt -Encoding 932
Get-Content .\legacy-big5.txt -Encoding 950
```

PowerShell 7.4+ also supports `-Encoding ansi` for the current culture's ANSI code page. Prefer explicit numeric IDs when the external contract is known and must not depend on the machine locale.

### Windows PowerShell 5.1

Encoding behavior is less consistent across cmdlets.

Important compatibility facts:

- `-Encoding UTF8` means UTF-8 with BOM.
- `-Encoding Default` uses the system active code page, typically the ANSI code page.
- `-Encoding Oem` uses the current OEM code page.
- A UTF-8 script without BOM that contains non-ASCII characters can be misread as the legacy ANSI code page.

If a `.ps1` must run under Windows PowerShell 5.1 and contains Chinese/Japanese/Korean or other non-ASCII literals, UTF-8 with BOM is usually the safer UTF-8 choice unless the project mandates another encoding.

## Preserve existing files

When editing existing project files:

1. Determine or preserve the existing encoding.
2. Avoid read/modify/write patterns that silently choose a new default encoding.
3. Do not convert GBK/CP936, CP932, CP949, CP950, UTF-8 BOM, or other established files merely because UTF-8 is more modern.
4. Treat encoding conversion as a migration that may affect compilers, parsers, servers, batch scripts, source-control diffs, and native tools.

If byte-for-byte encoding preservation matters, use an explicit `System.Text.Encoding` instance:

```powershell
$encoding = [System.Text.Encoding]::GetEncoding(936)
$text = [System.IO.File]::ReadAllText($path, $encoding)

# modify $text

[System.IO.File]::WriteAllText($path, $text, $encoding)
```

## Console code page is not file encoding

`chcp` changes the active console code page. It does not convert existing files.

Avoid generic fixes such as:

```batch
chcp 65001
```

or:

```batch
chcp 936
```

unless the problem is specifically a console/native program contract that requires that code page.

Programs started after a code-page change may use the new console page; already-running programs can retain their previous behavior.

## PowerShell -> native stdin

`$OutputEncoding` controls the encoding PowerShell uses when piping text into native applications.

In most scenarios it should align with `[Console]::InputEncoding`, but a known native protocol may require a different encoding.

Scope changes and restore them:

```powershell
$oldOutputEncoding = $OutputEncoding

try {
    $OutputEncoding = [System.Text.Encoding]::GetEncoding(932)
    '日本語' | legacy-japanese-tool.exe
}
finally {
    $OutputEncoding = $oldOutputEncoding
}
```

Do not permanently modify a user's PowerShell profile just to make one legacy command work.

## Native stdout/stderr -> PowerShell

Do not assume native output follows the Windows locale.

Possible cases include:

- modern CLI emits UTF-8;
- old Japanese CLI emits CP932;
- old Simplified-Chinese CLI emits CP936;
- old Traditional-Chinese CLI emits CP950;
- tool follows active console/OEM code page;
- tool has an explicit encoding flag.

Prefer the executable's documentation or a verified test over locale inference.

When PowerShell/host support provides a dedicated native-output decoding control, feature-detect it before use rather than assuming it exists on all PowerShell versions.

## Mixed-locale example

A Simplified-Chinese Windows machine can legitimately have:

```text
Windows ANSI code page     CP936
project JSON               UTF-8
legacy Japanese CLI        CP932
PowerShell 7 script        UTF-8 no BOM
Windows PowerShell 5.1 ps1 UTF-8 BOM
```

The correct solution is boundary-specific conversion, not forcing the entire session to one code page.

## Agent decision procedure

Before changing encoding behavior:

1. Identify PowerShell/CMD version and host.
2. Identify the data source and destination.
3. Determine whether the boundary is a file, console, stdin, stdout/stderr, or script source.
4. Prefer explicit producer/consumer documentation.
5. If the existing project encoding is known, preserve it.
6. If uncertain and a write would be destructive, inspect bytes/BOM or ask only if evidence cannot resolve the ambiguity.
7. Make encoding changes as narrow and reversible as possible.
