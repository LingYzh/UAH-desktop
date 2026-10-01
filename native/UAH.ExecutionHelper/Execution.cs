using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace UAH.ExecutionHelper;

internal sealed class Execution : IDisposable
{
    internal static readonly string ShellPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    internal const string ShellFlags = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand";
    internal static string ShellVersion {
        get { try { return FileVersionInfo.GetVersionInfo(ShellPath).FileVersion ?? "unknown"; } catch { return "unknown"; } }
    }
    private readonly object gate = new();
    private readonly SafeFileHandle job;
    private SafeFileHandle? process;
    private long stdoutBytes, stderrBytes;
    private long receivedBytes;
    private bool outputRedacted;
    private readonly byte[][] redactSecrets;
    private string status = "running";
    private string? reason;
    private uint? exitCode;
    private uint activeProcesses = 1;
    private bool drained;
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly long maxBytes;
    private readonly int timeout;
    internal string Id { get; }
    internal string StdoutPath { get; }
    internal string StderrPath { get; }
    internal Task Completion { get; private set; } = Task.CompletedTask;

    internal Execution(string id, string command, string cwd, string output, int timeoutMs, long maxOutputBytes, byte[][] redactSecrets)
    {
        Native.ValidateAbi();
        Id = id; timeout = timeoutMs; maxBytes = maxOutputBytes; this.redactSecrets = redactSecrets;
        StdoutPath = Path.Combine(output, "stdout.bin"); StderrPath = Path.Combine(output, "stderr.bin");
        job = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (job.IsInvalid) { job.Dispose(); throw new IOException("Job creation failed."); }
        SafeFileHandle? outRead = null, outWrite = null, errRead = null, errWrite = null, input = null;
        FileStream? stdoutFile = null, stderrFile = null;
        FileStream? outStream = null, errStream = null;
        try
        {
            var limits = new Native.ExtendedLimits { Basic = new Native.BasicLimits { Flags = Native.KillOnClose } };
            Native.Check(Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<Native.ExtendedLimits>()));
            var attributes = new Native.SecurityAttributes { Length = Marshal.SizeOf<Native.SecurityAttributes>(), Inherit = true };
            Native.Check(Native.CreatePipe(out outRead, out outWrite, ref attributes, 0));
            Native.Check(Native.CreatePipe(out errRead, out errWrite, ref attributes, 0));
            Native.Check(Native.SetHandleInformation(outRead, 1, 0));
            Native.Check(Native.SetHandleInformation(errRead, 1, 0));
            input = Native.CreateFileW("NUL", 0x80000000, 3, ref attributes, 3, 0, IntPtr.Zero);
            if (input.IsInvalid) throw new IOException("NUL input could not be opened.");
            stdoutFile = new FileStream(StdoutPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096);
            stderrFile = new FileStream(StderrPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096);
            using var list = new AttributeList();
            list.Add(Native.JobList, job.DangerousGetHandle());
            list.Add(Native.HandleList, input.DangerousGetHandle(), outWrite.DangerousGetHandle(), errWrite.DangerousGetHandle());
            var startup = new Native.StartupInfoEx { Attributes = list.Pointer, Info = new Native.StartupInfo { Size = (uint)Marshal.SizeOf<Native.StartupInfoEx>(), Flags = 0x100, Input = input.DangerousGetHandle(), Output = outWrite.DangerousGetHandle(), Error = errWrite.DangerousGetHandle() } };
            var shell = ShellPath;
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(command));
            // Job assignment is atomic inside CreateProcess, never a post-start operation.
            Native.Check(Native.CreateProcessW(shell, new StringBuilder($"\"{shell}\" {ShellFlags} {encoded}"), IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x08000000, IntPtr.Zero, cwd, ref startup, out var created));
            process = new SafeFileHandle(created.Process, true);
            using (new SafeFileHandle(created.Thread, true)) { }
            Native.Check(Native.IsProcessInJob(process, job, out var inside));
            if (!inside) throw new IOException("Process ownership could not be verified.");
            outWrite.Dispose(); outWrite = null; errWrite.Dispose(); errWrite = null; input.Dispose(); input = null;
            outStream = new FileStream(outRead, FileAccess.Read, 4096, false); outRead = null;
            errStream = new FileStream(errRead, FileAccess.Read, 4096, false); errRead = null;
            var outPump = Pump(outStream, stdoutFile, true); stdoutFile = null; outStream = null;
            var errPump = Pump(errStream, stderrFile, false); stderrFile = null; errStream = null;
            Completion = Monitor(outPump, errPump);
        }
        catch
        {
            // Even post-create errors close the noninherited kill-on-close job.
            job.Dispose(); process?.Dispose();
            outRead?.Dispose(); errRead?.Dispose(); outStream?.Dispose(); errStream?.Dispose(); stdoutFile?.Dispose(); stderrFile?.Dispose();
            throw;
        }
        finally { outWrite?.Dispose(); errWrite?.Dispose(); input?.Dispose(); }
    }
    private Task Pump(FileStream pipe, FileStream output, bool stdout) => Task.Run(() =>
    {
        using (pipe) using (output)
        {
            var buffer = new byte[16384];
            var filter = new LiteralByteFilter(redactSecrets);
            try
            {
                int count;
                while ((count = pipe.Read(buffer)) != 0)
                {
                    lock (gate)
                    {
                        // Withheld filter tails also consume the raw output quota.
                        var allowed = (int)Math.Min(count, Math.Max(0, maxBytes - receivedBytes));
                        if (allowed > 0)
                        {
                            receivedBytes += allowed;
                            var written = filter.Write(buffer.AsSpan(0, allowed), output); output.Flush();
                            outputRedacted |= filter.Matched;
                            if (stdout) stdoutBytes += written; else stderrBytes += written;
                        }
                        if (allowed != count) StopLocked("output_limit");
                    }
                }
                lock (gate)
                {
                    var written = filter.Flush(output); output.Flush();
                    outputRedacted |= filter.Matched;
                    if (stdout) stdoutBytes += written; else stderrBytes += written;
                }
            }
            catch { lock (gate) StopLocked("output_error"); throw; }
        }
    });
    private async Task Monitor(Task stdout, Task stderr)
    {
        try
        {
            while (true)
            {
                lock (gate)
                {
                    Native.Check(Native.QueryInformationJobObject(job, 1, out var info, (uint)Marshal.SizeOf<Native.Accounting>(), IntPtr.Zero));
                    activeProcesses = info.ActiveProcesses;
                    if (activeProcesses == 0) break;
                    if (clock.ElapsedMilliseconds >= timeout) StopLocked("timeout");
                }
                await Task.Delay(10);
            }
            await Task.WhenAll(stdout, stderr);
            lock (gate)
            {
                Native.Check(Native.GetExitCodeProcess(process!, out var code));
                exitCode = code; drained = true;
                status = reason switch { "cancelled" or "shutdown" => "cancelled", "timeout" => "timed_out", "output_limit" or "output_error" => "failed", _ => code == 0 ? "completed" : "failed" };
            }
        }
        catch
        {
            lock (gate) { reason ??= "management_error"; status = "failed"; }
            // Fail closed, but never fabricate a treeExited certificate if query/drain failed.
            job.Dispose();
            try { await Task.WhenAll(stdout, stderr); } catch { }
        }
    }
    private void StopLocked(string why)
    {
        if (status != "running" || reason != null) return;
        Native.Check(Native.TerminateJobObject(job, 1));
        reason = why;
    }
    internal void Cancel(string why = "cancelled") { lock (gate) StopLocked(why); }
    internal void Release()
    {
        lock (gate)
        {
            if (status == "running" || activeProcesses != 0 || !drained)
                throw new ProtocolException("execution_not_terminal", "Release requires confirmed tree exit and drained output.");
            // Both pumps have disposed their files and Monitor has finished native queries.
            // Keep raw files on disk; only this execution's owned lifecycle handles close.
            Dispose();
        }
    }
    internal object Snapshot()
    {
        lock (gate) return new { executionId = Id, status, reason, exitCode, jobAssigned = true, activeProcesses, treeExited = activeProcesses == 0 && drained, outputDrained = drained, outputRedacted, stdoutPath = StdoutPath, stderrPath = StderrPath, stdoutBytes, stderrBytes, elapsedMs = clock.ElapsedMilliseconds };
    }
    internal object Poll(string stream, long offset, int limit)
    {
        lock (gate)
        {
            var length = stream == "stdout" ? stdoutBytes : stderrBytes;
            if (offset > length) throw new ProtocolException("invalid_offset", "Offset exceeds available output.");
            using var file = new FileStream(stream == "stdout" ? StdoutPath : StderrPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            file.Position = offset;
            var bytes = new byte[(int)Math.Min(limit, length - offset)];
            file.ReadExactly(bytes);
            return new { executionId = Id, stream, offset, nextOffset = offset + bytes.Length, base64 = Convert.ToBase64String(bytes), hasMore = offset + bytes.Length < length, snapshot = Snapshot() };
        }
    }
    public void Dispose() { job.Dispose(); process?.Dispose(); }
}
