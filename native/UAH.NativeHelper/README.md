# UAH.NativeHelper

`UAH.NativeHelper` is a small Windows-only .NET 10 process for read-only foreground-window observation. It uses JSON Lines over standard input and standard output, so a parent process can start it hidden with redirected streams. Standard output contains protocol responses only; diagnostics are not written there.

## Build and run

Install the .NET 10 SDK, then build the release executable from the repository root:

```powershell
dotnet build .\native\UAH.NativeHelper\UAH.NativeHelper.csproj -c Release
```

The executable is written to:

```text
native/UAH.NativeHelper/bin/Release/net10.0-windows/UAH.NativeHelper.exe
```

For an interactive protocol session:

```powershell
& .\native\UAH.NativeHelper\bin\Release\net10.0-windows\UAH.NativeHelper.exe
```

Run the redirected-stdio protocol checks after building:

```powershell
node .\tests\native\protocol.test.mjs
```

Send one UTF-8 JSON object per line. A line may contain up to 65,536 characters. EOF exits normally. A `shutdown` request is acknowledged before the process exits.

## Protocol

Every request has a non-empty string `id` (up to 256 characters) and a string `method`:

```json
{"id":"1","method":"capabilities"}
{"id":"2","method":"observe-foreground"}
{"id":"3","method":"shutdown"}
```

Responses echo the request id and contain either `result` or `error`:

```json
{"id":"1","result":{"platform":"windows","observation":true,"actions":false,"processGroups":false}}
```

`observe-foreground` returns a `snapshotId`, UTC `observedAt`, hexadecimal `hwnd` string, numeric `processId`, and the Win32 window `title` and `className`. `uiaRoot`, when available, contains only the foreground window's UI Automation root `title`, `className`, `automationId`, and `controlType`. If UI Automation access fails, `uiaRoot` is omitted and `uiaError` gives a short reason. If there is no usable foreground window, the response contains an `error`.

Unknown methods, malformed JSON, invalid request fields, and overlong lines receive an error response. Overlong input is drained through its newline so the next request can still be handled. Invalid UTF-8 terminates the process with a nonzero runtime error; callers should send UTF-8.

## Boundaries

The helper reads only foreground-window metadata and properties on the UI Automation root element. It does not enumerate descendants, read password contents, capture screenshots, send keyboard or mouse input, execute commands, access cookies or credentials, or manage/terminate processes. `actions` and `processGroups` are always reported as `false`.

UI Automation access is subject to Windows integrity-level and desktop restrictions. A successful root-element lookup is not a sandbox or a guarantee that all applications expose metadata. The parent should treat `uiaRoot` as optional and must not infer that the helper is isolated from the observed application.
