using System.Text;
using System.Text.Json;

namespace UAH.ExecutionHelper;

internal sealed class ProtocolException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}

internal static class Program
{
    private static readonly Dictionary<string, Execution> executions = new(StringComparer.Ordinal);
    private static readonly SemaphoreSlim outputLock = new(1);
    private static bool shuttingDown;
    private static int pending;
    public static async Task Main()
    {
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false);
        var tasks = new List<Task>();
        try
        {
            while (!shuttingDown)
            {
                var (line, oversized) = await ReadLineBounded();
                if (line == null) break;
                tasks.RemoveAll(task => task.IsCompleted);
                if (oversized) { await Send(new { id = (string?)null, ok = false, error = new { code = "invalid_request", message = "Request line exceeds 131072 characters." } }); continue; }
                // Dispatch runs synchronously through validation/start/cancel until its first await.
                // Only waits yield, so a blocked wait cannot block cancellation or stdin consumption.
                tasks.Add(Dispatch(line));
            }
        }
        finally
        {
            shuttingDown = true;
            foreach (var execution in executions.Values) { try { execution.Cancel("shutdown"); } catch { } }
            try { await Task.WhenAll(executions.Values.Select(e => e.Completion)).WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            foreach (var execution in executions.Values) execution.Dispose();
            try { await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(1)); } catch { }
        }
    }
    private static async Task<(string? Line, bool Oversized)> ReadLineBounded()
    {
        var text = new StringBuilder(); var oversized = false; var buffer = new char[1];
        while (true)
        {
            if (await Console.In.ReadAsync(buffer.AsMemory()) == 0) return text.Length == 0 && !oversized ? (null, false) : (text.ToString(), oversized);
            if (buffer[0] == '\n') return (text.ToString().TrimEnd('\r'), oversized);
            if (text.Length < 131072) text.Append(buffer[0]); else oversized = true;
        }
    }
    private static async Task Dispatch(string line)
    {
        string? id = null; var counted = false;
        try
        {
            using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 8 });
            var request = document.RootElement;
            // Preserve a unique valid id even when another field is malformed.
            if (request.ValueKind == JsonValueKind.Object && request.EnumerateObject().Count(p => p.Name == "id") == 1) id = Text(request, "id", 128);
            Fields(request, "id", "method", "params");
            id = Text(request, "id", 128);
            var method = Text(request, "method", 32);
            var args = Required(request, "params");
            if (Interlocked.Increment(ref pending) > 64) { Interlocked.Decrement(ref pending); throw new ProtocolException("busy", "At most 64 pending requests are supported."); }
            counted = true;
            object result;
            switch (method)
            {
                case "capabilities":
                    Fields(args);
                    var shellVersion = Execution.ShellVersion;
                    result = new { protocolVersion = 1, backend = "windows-job-object", platformSupported = Native.PlatformSupported, processGroups = Native.PlatformSupported, atomicJobAssignment = true, breakawayAllowed = false, redirectedStdio = true, credentialFilter = true, interactive = false, pty = false, sandboxed = false, terminalRelease = true, maxRetainedExecutions = 128, maxPollBytes = 65536, maxTimeoutMs = 120000, maxWaitMs = 30000, defaultMaxOutputBytes = 16777216, maxOutputBytes = 67108864, maxCommandCharacters = 8192, shell = Execution.ShellPath, shellVersion, shellVersionSource = shellVersion == "unknown" ? "unknown" : "executable_file_version", shellArguments = Execution.ShellFlags.Split(' '), commandEncoding = "utf16le-base64", outputEncoding = "raw_bytes_command_specific", ownership = "noninherited Job Object handle; KILL_ON_JOB_CLOSE; JOB_LIST at CreateProcess" };
                    break;
                case "start":
                    Fields(args, "executionId", "command", "cwd", "outputDirectory", "timeoutMs", "maxOutputBytes", "redactSecrets");
                    var secrets = Secrets(args);
                    var executionId = Text(args, "executionId", 36);
                    if (!Guid.TryParseExact(executionId, "D", out _)) throw new ProtocolException("invalid_request", "executionId must be a UUID.");
                    var command = Text(args, "command", 8192);
                    var cwd = AbsoluteDirectory(Text(args, "cwd", 1024));
                    var output = AbsoluteDirectory(Text(args, "outputDirectory", 1024));
                    var timeout = (int)Integer(args, "timeoutMs", 1, 120000);
                    var maxBytes = args.TryGetProperty("maxOutputBytes", out _) ? Integer(args, "maxOutputBytes", 1, 67108864) : 16777216;
                    if (executions.ContainsKey(executionId)) throw new ProtocolException("duplicate_execution", "executionId was already used.");
                    if (executions.Count >= 128 || executions.Values.Count(e => !e.Completion.IsCompleted) >= 16) throw new ProtocolException("busy", "Execution retention or concurrency limit reached; explicitly release confirmed terminal executions.");
                    if (Directory.EnumerateFileSystemEntries(output).Any()) throw new ProtocolException("invalid_request", "outputDirectory must be empty and dedicated to this execution.");
                    var execution = new Execution(executionId, command, cwd, output, timeout, maxBytes, secrets);
                    executions.Add(executionId, execution);
                    result = execution.Snapshot();
                    break;
                case "poll":
                    Fields(args, "executionId", "stream", "offset", "limit");
                    var stream = Text(args, "stream", 6);
                    if (stream is not ("stdout" or "stderr")) throw new ProtocolException("invalid_request", "stream must be stdout or stderr.");
                    result = Find(args).Poll(stream, Integer(args, "offset", 0, 67108864), (int)Integer(args, "limit", 1, 65536));
                    break;
                case "wait":
                    Fields(args, "executionId", "timeoutMs");
                    var waiting = Find(args); var waitMs = (int)Integer(args, "timeoutMs", 0, 30000);
                    await Task.WhenAny(waiting.Completion, Task.Delay(waitMs));
                    result = waiting.Snapshot();
                    break;
                case "cancel":
                    Fields(args, "executionId");
                    var cancelled = Find(args); cancelled.Cancel();
                    await Task.WhenAny(cancelled.Completion, Task.Delay(5000));
                    result = cancelled.Snapshot();
                    break;
                case "release":
                    Fields(args, "executionId");
                    var released = Find(args);
                    released.Release();
                    executions.Remove(released.Id);
                    result = new { executionId = released.Id, status = "released", rawOutputRetained = true };
                    break;
                case "shutdown":
                    Fields(args); shuttingDown = true;
                    foreach (var item in executions.Values) item.Cancel("shutdown");
                    await Task.WhenAny(Task.WhenAll(executions.Values.Select(e => e.Completion)), Task.Delay(5000));
                    result = new { status = "shutdown", executions = executions.Values.Select(e => e.Snapshot()).ToArray() };
                    break;
                default: throw new ProtocolException("unsupported_method", "Method is not supported.");
            }
            await Send(new { id, ok = true, result });
        }
        catch (ProtocolException error) { await Send(new { id, ok = false, error = new { code = error.Code, message = error.Message } }); }
        catch (JsonException) { await Send(new { id, ok = false, error = new { code = "invalid_json", message = "Request must be valid JSON." } }); }
        catch { await Send(new { id, ok = false, error = new { code = "backend_error", message = "Execution backend failed; no uncontrolled fallback was used." } }); }
        finally { if (counted) Interlocked.Decrement(ref pending); }
    }
    private static Execution Find(JsonElement args)
    {
        var id = Text(args, "executionId", 36);
        if (!executions.TryGetValue(id, out var execution)) throw new ProtocolException("unknown_execution", "executionId is not owned by this helper.");
        return execution;
    }
    private static void Fields(JsonElement value, params string[] allowed)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new ProtocolException("invalid_request", "Expected an object.");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject()) if (!allowed.Contains(property.Name, StringComparer.Ordinal) || !seen.Add(property.Name)) throw new ProtocolException("invalid_request", "Unknown or duplicate field.");
    }
    private static JsonElement Required(JsonElement value, string field)
    {
        if (!value.TryGetProperty(field, out var item)) throw new ProtocolException("invalid_request", "Required field is missing.");
        return item;
    }
    private static string Text(JsonElement value, string field, int max)
    {
        var item = Required(value, field);
        if (item.ValueKind != JsonValueKind.String) throw new ProtocolException("invalid_request", "Expected a string field.");
        var text = item.GetString()!;
        if (text.Length == 0 || text.Length > max || text.Contains('\0')) throw new ProtocolException("invalid_request", "String field is empty, too long, or contains NUL.");
        return text;
    }
    private static long Integer(JsonElement value, string field, long min, long max)
    {
        var item = Required(value, field);
        if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out var number) || number < min || number > max) throw new ProtocolException("invalid_request", "Integer field is outside its allowed range.");
        return number;
    }
    private static byte[][] Secrets(JsonElement value)
    {
        if (!value.TryGetProperty("redactSecrets", out var secrets)) return [];
        if (secrets.ValueKind != JsonValueKind.Array || secrets.GetArrayLength() > 16)
            throw new ProtocolException("invalid_request", "Invalid credential filter configuration.");
        var result = new List<byte[]>(); var total = 0;
        foreach (var item in secrets.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String) throw new ProtocolException("invalid_request", "Invalid credential filter configuration.");
            var text = item.GetString()!;
            if (text.Length == 0 || text.Length > 8192 || text.Any(character => character < 0x20 || character > 0x7e))
                throw new ProtocolException("invalid_request", "Invalid credential filter configuration.");
            total += text.Length;
            if (total > 65536) throw new ProtocolException("invalid_request", "Invalid credential filter configuration.");
            result.Add(Encoding.ASCII.GetBytes(text));
        }
        return result.ToArray();
    }
    private static string AbsoluteDirectory(string directory)
    {
        if (!Path.IsPathFullyQualified(directory) || directory.StartsWith("\\\\", StringComparison.Ordinal) || !Directory.Exists(directory)) throw new ProtocolException("invalid_request", "Directory must be an existing absolute local path.");
        var full = Path.GetFullPath(directory);
        for (var current = new DirectoryInfo(full); current != null; current = current.Parent) if ((current.Attributes & FileAttributes.ReparsePoint) != 0) throw new ProtocolException("invalid_request", "Directory cannot traverse reparse points.");
        return full;
    }
    private static async Task Send(object response)
    {
        await outputLock.WaitAsync();
        try { await Console.Out.WriteLineAsync(JsonSerializer.Serialize(response)); await Console.Out.FlushAsync(); }
        finally { outputLock.Release(); }
    }
}
