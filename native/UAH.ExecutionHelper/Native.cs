using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace UAH.ExecutionHelper;

// Win32 ABI: pointer-sized SIZE_T/ULONG_PTR; default platform alignment.
internal static class Native
{
    internal const uint KillOnClose = 0x2000;
    internal const nuint HandleList = 0x20002, JobList = 0x2000D;
    internal static bool PlatformSupported => OperatingSystem.IsWindowsVersionAtLeast(10, 0) && Environment.Is64BitProcess;
    internal static void ValidateAbi()
    {
        if (!PlatformSupported) throw new ProtocolException("unsupported_platform", "Windows 10+ and a 64-bit helper are required.");
        if (Marshal.SizeOf<BasicLimits>() != 64 || Marshal.SizeOf<ExtendedLimits>() != 144 || Marshal.SizeOf<Accounting>() != 48 || Marshal.SizeOf<StartupInfo>() != 104 || Marshal.SizeOf<StartupInfoEx>() != 112 || Marshal.SizeOf<SecurityAttributes>() != 24)
            throw new ProtocolException("unsupported_platform", "Win32 structure layout validation failed.");
    }
    [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits { public long ProcessTime, JobTime; public uint Flags; public nuint MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit; public nuint Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public nuint ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] internal struct Accounting { public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct StartupInfo { public uint Size; public IntPtr Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; public ushort Show, ReservedSize; public IntPtr Reserved2, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] internal struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool IsProcessInJob(SafeFileHandle process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool inside);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetExitCodeProcess(SafeFileHandle process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(SafeFileHandle handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern SafeFileHandle CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref nuint size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, nuint attribute, IntPtr value, nuint size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    internal static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
}

internal sealed class AttributeList : IDisposable
{
    internal IntPtr Pointer;
    private readonly List<IntPtr> values = [];
    private bool initialized;
    internal AttributeList()
    {
        nuint size = 0;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        Pointer = Marshal.AllocHGlobal(checked((int)size));
        try { Native.Check(Native.InitializeProcThreadAttributeList(Pointer, 2, 0, ref size)); initialized = true; }
        catch { Dispose(); throw; }
    }
    internal void Add(nuint key, params IntPtr[] handles)
    {
        var value = Marshal.AllocHGlobal(handles.Length * IntPtr.Size);
        values.Add(value);
        Marshal.Copy(handles, 0, value, handles.Length);
        Native.Check(Native.UpdateProcThreadAttribute(Pointer, 0, key, value, (nuint)(handles.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
    }
    public void Dispose()
    {
        if (initialized) Native.DeleteProcThreadAttributeList(Pointer);
        initialized = false;
        foreach (var value in values) Marshal.FreeHGlobal(value);
        values.Clear();
        if (Pointer != IntPtr.Zero) Marshal.FreeHGlobal(Pointer);
        Pointer = IntPtr.Zero;
    }
}
