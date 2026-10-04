# WMI / CIM Reference

## Prefer CIM over WMI

| Legacy WMI | Modern CIM |
|------------|------------|
| `Get-WmiObject` | `Get-CimInstance` |
| WMI cmdlets return live objects with methods | CIM returns serializable objects |
| `\root\cimv2` default namespace | `root/cimv2` default namespace |
| RPC-based | WS-Man by default; can use DCOM session options |

PowerShell 7 does not include `Get-WmiObject`. Always prefer `Get-CimInstance`.

## Common CIM queries

```powershell
# Operating system info
Get-CimInstance -ClassName Win32_OperatingSystem |
    Select-Object Caption, Version, OSArchitecture, TotalVisibleMemorySize

# Computer system
Get-CimInstance -ClassName Win32_ComputerSystem |
    Select-Object Name, Manufacturer, Model, TotalPhysicalMemory

# Process list with owner
Get-CimInstance -ClassName Win32_Process |
    Select-Object Name, ProcessId, CommandLine

# Disk drives
Get-CimInstance -ClassName Win32_LogicalDisk |
    Select-Object DeviceID, @{N='SizeGB';E={[math]::Round($_.Size/1GB,2)}}, @{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB,2)}}

# Network adapters
Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = TRUE' |
    Select-Object Description, MACAddress, IPAddress, DefaultIPGateway

# BIOS
Get-CimInstance -ClassName Win32_BIOS |
    Select-Object Manufacturer, Name, SerialNumber
```

## Query with filters

```powershell
# Filter at the source (more efficient)
Get-CimInstance -ClassName Win32_Process -Filter "Name = 'notepad.exe'"

# Equivalent with Where-Object (pulls all, then filters)
Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -eq 'notepad.exe' }
```

## Invoking methods

```powershell
# Get process owner
$proc = Get-CimInstance -ClassName Win32_Process -Filter "Name='notepad.exe'" | Select-Object -First 1
if ($proc) {
    $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwner
    $owner
}

# Terminate a process
$proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=1234"
Invoke-CimMethod -InputObject $proc -MethodName Terminate
```

## Remote CIM

```powershell
# Requires WinRM and firewall rules
$session = New-CimSession -ComputerName SERVER01 -Credential (Get-Credential)
Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem
Remove-CimSession -CimSession $session
```

## Finding classes

```powershell
# List CIM classes
Get-CimClass | Where-Object { $_.CimClassName -like '*Process*' }

# List methods of a class
(Get-CimClass -ClassName Win32_Process).CimClassMethods

# List properties of a class
(Get-CimClass -ClassName Win32_Process).CimClassProperties
```

## Legacy WMI (avoid)

```powershell
# Only use if you are forced to run on Windows PowerShell 2.0
Get-WmiObject -Class Win32_OperatingSystem
```

## CMD alternative

CMD has no native CIM/WMI support. Use `wmic.exe` (deprecated) or PowerShell:

```batch
wmic os get caption, version, osarchitecture
```

Prefer PowerShell/CIM for any new work.
