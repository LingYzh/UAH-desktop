# Services, Processes, and Scheduled Tasks Reference

## Services

### PowerShell

```powershell
# List all services
Get-Service

# Find stopped automatic services
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -eq 'Stopped' }

# Get detailed service info
Get-Service -Name Spooler | Select-Object *

# Start / stop / restart (preview with -WhatIf first)
Start-Service -Name Spooler -WhatIf
Stop-Service -Name Spooler -WhatIf
Restart-Service -Name Spooler -WhatIf

# Set start type (preview with -WhatIf first)
Set-Service -Name Spooler -StartupType Automatic -WhatIf
```

### CMD

```batch
sc query Spooler
:: sc query supports type= and state= only. Start-type filtering requires PowerShell.
sc query type= service state= stopped
sc start Spooler
sc stop Spooler
sc config Spooler start= auto
```

Note: spaces after `=` are required in `sc config`.

## Processes

### PowerShell

```powershell
# List processes
Get-Process

# Find by name
Get-Process -Name notepad

# Find by owner (requires elevated session)
Get-CimInstance Win32_Process -Filter "Name='notepad.exe'" |
    Invoke-CimMethod -MethodName GetOwner

# Stop a process
Stop-Process -Name notepad -WhatIf

# Start a process
Start-Process -FilePath 'notepad.exe' -ArgumentList 'C:\temp\file.txt'

# Wait for exit
$proc = Start-Process -FilePath 'notepad.exe' -PassThru
$proc.WaitForExit()
```

### CMD

```batch
tasklist
tasklist /FI "IMAGENAME eq notepad.exe"
taskkill /IM notepad.exe /F
start notepad.exe C:\temp\file.txt
```

## Scheduled Tasks

### PowerShell (ScheduledTasks module)

```powershell
# List tasks
Get-ScheduledTask

# Get a specific task
Get-ScheduledTask -TaskName 'MyTask' -ErrorAction SilentlyContinue

# Register a simple daily task
$action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-File C:\scripts\backup.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At '02:00'
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet
Register-ScheduledTask -TaskName 'NightlyBackup' -Action $action -Trigger $trigger -Principal $principal -Settings $settings

# Unregister
Unregister-ScheduledTask -TaskName 'NightlyBackup' -Confirm:$false -WhatIf
```

### CMD (schtasks)

```batch
schtasks /query /fo LIST
schtasks /create /tn "NightlyBackup" /tr "pwsh.exe -File C:\scripts\backup.ps1" /sc daily /st 02:00 /ru SYSTEM
schtasks /delete /tn "NightlyBackup" /f
```

## Performance counters

```powershell
# CPU, memory, disk counters
Get-Counter -Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 5
Get-Counter -Counter '\Memory\Available MBytes'
Get-Counter -Counter '\PhysicalDisk(_Total)\% Disk Time'
```

## Elevation notes

- Starting, stopping, or configuring most services requires elevation.
- `Set-Service` and `Register-ScheduledTask` usually need administrator rights.
- Use `Start-Process pwsh -Verb runAs` to launch an elevated PowerShell 7 session from a non-elevated one. If only Windows PowerShell 5.1 is available, use `powershell` instead.
