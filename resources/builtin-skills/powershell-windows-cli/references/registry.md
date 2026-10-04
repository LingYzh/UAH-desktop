# Windows Registry Reference

## Registry drives

PowerShell exposes registry hives as drives:

| Hive | PowerShell path |
|------|-----------------|
| HKEY_CURRENT_USER | `HKCU:\` |
| HKEY_LOCAL_MACHINE | `HKLM:\` |
| HKEY_CLASSES_ROOT | `HKCR:\` (not mounted by default) |
| HKEY_USERS | `HKU:\` |
| HKEY_CURRENT_CONFIG | `HKCC:\` |

If `HKCR:` is needed:

```powershell
New-PSDrive -Name HKCR -PSProvider Registry -Root HKEY_CLASSES_ROOT
```

## Reading values

```powershell
# Read a single value
Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name ReleaseId

# Read all values of a key
Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'

# Test if a value exists
$path = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$item = Get-ItemProperty -Path $path -Name ReleaseId -ErrorAction SilentlyContinue
if ($item) { Write-Host 'exists' }
```

## Writing values

```powershell
# Create the key if it does not exist
New-Item -Path 'HKCU:\Software\MyCompany' -Force

# Set a string value
Set-ItemProperty -Path 'HKCU:\Software\MyCompany' -Name 'InstallDir' -Value 'C:\MyApp'

# Set a DWORD
Set-ItemProperty -Path 'HKCU:\Software\MyCompany' -Name 'Enabled' -Value 1 -Type DWord

# Set an expandable string
Set-ItemProperty -Path 'HKCU:\Software\MyCompany' -Name 'Path' -Value '%SystemRoot%\System32' -Type ExpandString

# Supported types: String, DWord, QWord, Binary, MultiString, ExpandString
```

## Deleting values and keys

```powershell
# Remove a value
Remove-ItemProperty -Path 'HKCU:\Software\MyCompany' -Name 'Enabled' -WhatIf

# Remove a key recursively
Remove-Item -Path 'HKCU:\Software\MyCompany' -Recurse -WhatIf
```

## Searching the registry

```powershell
# Find keys by name
Get-ChildItem -Path 'HKLM:\SOFTWARE\Microsoft' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -like '*Windows*' }

# Find values containing a string across a hive (can be slow)
Get-ChildItem -Path 'HKLM:\SOFTWARE' -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object {
        $key = $_
        $properties = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
        $properties.PSObject.Properties |
            Where-Object { $_.Value -is [string] -and $_.Value -like '*searchterm*' } |
            Select-Object @{N='Key';E={$key.PSPath}}, Name, Value
    }
```

## Registry from CMD

CMD has no built-in registry editing; use `reg.exe`:

```batch
:: Query a value
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v ReleaseId

:: Add/modify a string value
reg add "HKCU\Software\MyCompany" /v InstallDir /t REG_SZ /d "C:\MyApp" /f

:: Add a DWORD
reg add "HKCU\Software\MyCompany" /v Enabled /t REG_DWORD /d 1 /f

:: Delete a value
reg delete "HKCU\Software\MyCompany" /v Enabled /f

:: Delete a key recursively
reg delete "HKCU\Software\MyCompany" /f
```

## Safety notes

- Modifying `HKLM` usually requires elevation.
- Always export a key before destructive changes:
  ```powershell
  reg export 'HKCU\Software\MyCompany' 'C:\backup\mycompany.reg'
  ```
- Use `-WhatIf` with `Remove-ItemProperty` and `Remove-Item` first.
- Avoid editing `HKCR` unless you understand the relationship between `HKLM\Software\Classes` and `HKCU\Software\Classes`.
