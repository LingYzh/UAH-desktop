using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Automation;

namespace UAH.NativeHelper;

internal static class Program
{
    private const int MaximumLineLength = 65_536;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    [MTAThread]
    private static int Main()
    {
        Console.SetIn(new StreamReader(
            Console.OpenStandardInput(),
            new UTF8Encoding(false, true),
            detectEncodingFromByteOrderMarks: false));
        Console.SetOut(new StreamWriter(
            Console.OpenStandardOutput(),
            new UTF8Encoding(false),
            bufferSize: 1024)
        {
            AutoFlush = true
        });

        while (true)
        {
            var read = ReadBoundedLine(Console.In, MaximumLineLength);
            if (read.EndOfStream)
            {
                return 0;
            }

            if (read.TooLong)
            {
                WriteResponse(null, error: $"Input line exceeds the {MaximumLineLength}-character limit.");
                continue;
            }

            var line = read.Line!;
            if (!TryParseRequest(line, out var request, out var parseError))
            {
                WriteResponse(request?.Id, error: parseError);
                continue;
            }

            if (request!.Id is null || request.Id.Length == 0 || request.Id.Length > 256)
            {
                WriteResponse(request.Id, error: "Request id must be a non-empty string of at most 256 characters.");
                continue;
            }

            switch (request.Method)
            {
                case "capabilities":
                    WriteResponse(request.Id, result: new
                    {
                        platform = "windows",
                        observation = true,
                        actions = false,
                        processGroups = false
                    });
                    break;

                case "observe-foreground":
                    try
                    {
                        WriteResponse(request.Id, result: ObserveForeground());
                    }
                    catch (InvalidOperationException exception)
                    {
                        WriteResponse(request.Id, error: exception.Message);
                    }
                    break;

                case "shutdown":
                    WriteResponse(request.Id, result: new { shutdown = true });
                    return 0;

                default:
                    WriteResponse(request.Id, error: $"Unknown method '{request.Method}'.");
                    break;
            }
        }
    }

    private static (string? Line, bool TooLong, bool EndOfStream) ReadBoundedLine(TextReader reader, int maximumLength)
    {
        var builder = new StringBuilder(Math.Min(maximumLength, 1024));
        var tooLong = false;
        var readAny = false;

        while (true)
        {
            var value = reader.Read();
            if (value < 0)
            {
                return readAny
                    ? (builder.ToString(), tooLong, false)
                    : (null, false, true);
            }

            readAny = true;
            if (value == '\n')
            {
                if (builder.Length > 0 && builder[^1] == '\r')
                {
                    builder.Length--;
                }

                return (builder.ToString(), tooLong, false);
            }

            if (!tooLong)
            {
                if (builder.Length == maximumLength)
                {
                    tooLong = true;
                }
                else
                {
                    builder.Append((char)value);
                }
            }
        }
    }

    private static bool TryParseRequest(string line, out Request? request, out string error)
    {
        request = null;
        error = "Input must be a JSON object with string id and method fields.";

        try
        {
            using var document = JsonDocument.Parse(line);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var hasStringId = document.RootElement.TryGetProperty("id", out var idElement)
                && idElement.ValueKind == JsonValueKind.String;
            var hasStringMethod = document.RootElement.TryGetProperty("method", out var methodElement)
                && methodElement.ValueKind == JsonValueKind.String;
            var id = hasStringId ? idElement.GetString() : null;
            var method = hasStringMethod ? methodElement.GetString() : null;
            request = new Request(id, method);

            if (!hasStringId || !hasStringMethod)
            {
                return false;
            }

            return true;
        }
        catch (JsonException)
        {
            error = "Input is not valid JSON.";
            return false;
        }
    }

    private static object ObserveForeground()
    {
        var windowHandle = GetForegroundWindow();
        if (windowHandle == IntPtr.Zero)
        {
            throw new InvalidOperationException("No foreground window is available.");
        }

        var threadId = GetWindowThreadProcessId(windowHandle, out var processId);
        if (threadId == 0 || processId == 0 || !IsWindow(windowHandle))
        {
            throw new InvalidOperationException("The foreground window became unavailable during observation.");
        }

        var title = ReadWindowText(windowHandle);
        var className = ReadClassName(windowHandle);

        object? uiaRoot = null;
        string? uiaError = null;
        try
        {
            var root = AutomationElement.FromHandle(windowHandle);
            if (root is null)
            {
                uiaError = "UI Automation did not return a root element.";
            }
            else
            {
                var current = root.Current;
                uiaRoot = new
                {
                    title = current.Name,
                    className = current.ClassName,
                    automationId = current.AutomationId,
                    controlType = current.ControlType.ProgrammaticName
                };
            }
        }
        catch (Exception exception) when (exception is COMException or ElementNotAvailableException or UnauthorizedAccessException or InvalidOperationException)
        {
            uiaError = $"UI Automation root metadata unavailable ({exception.GetType().Name}).";
        }

        _ = GetWindowThreadProcessId(windowHandle, out var currentProcessId);
        if (!IsWindow(windowHandle) || GetForegroundWindow() != windowHandle || currentProcessId != processId)
        {
            throw new InvalidOperationException("The foreground target changed during observation. Observe again.");
        }

        return new
        {
            snapshotId = Guid.NewGuid().ToString("N"),
            observedAt = DateTimeOffset.UtcNow.ToString("O"),
            hwnd = $"0x{windowHandle.ToInt64():X}",
            processId,
            title,
            className,
            uiaRoot,
            uiaError
        };
    }

    private static string ReadWindowText(IntPtr windowHandle)
    {
        var length = Math.Clamp(GetWindowTextLength(windowHandle), 0, 32_767);
        var buffer = new StringBuilder(length + 1);
        _ = GetWindowText(windowHandle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string ReadClassName(IntPtr windowHandle)
    {
        var buffer = new StringBuilder(512);
        _ = GetClassName(windowHandle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static void WriteResponse(string? id, object? result = null, string? error = null)
    {
        var response = new Response(id, result, error);
        Console.Out.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
    }

    private sealed record Request(string? Id, string? Method);

    private sealed record Response(
        string? Id,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] object? Result,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowText(IntPtr windowHandle, StringBuilder text, int maximumCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextLength(IntPtr windowHandle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetClassName(IntPtr windowHandle, StringBuilder className, int maximumCount);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr windowHandle);
}
