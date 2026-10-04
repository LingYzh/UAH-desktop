# Bash to PowerShell / CMD Rosetta Stone

Use this reference when converting common Linux/bash commands to Windows.

## File system

| Bash | PowerShell | CMD |
|------|------------|-----|
| `ls` | `Get-ChildItem` | `DIR` |
| `ls -la` | `Get-ChildItem | Select-Object Mode, LastWriteTime, Length, Name` | `DIR /Q` |
| `ls -R` | `Get-ChildItem -Recurse` | `DIR /S /B` |
| `cd /tmp` | `Set-Location C:\temp` | `cd C:\temp` |
| `pwd` | `(Get-Location).Path` | `cd` |
| `cp src.txt dst.txt` | `Copy-Item src.txt dst.txt` | `copy src.txt dst.txt` |
| `mv src.txt dst/` | `Move-Item src.txt dst\` | `move src.txt dst\` |
| `rm file.txt` | `Remove-Item file.txt -WhatIf` | `del file.txt` |
| `rm -rf dir` | `Remove-Item -Recurse -Force dir -WhatIf` | `rmdir /S /Q dir` |
| `mkdir -p dir/sub` | `New-Item -ItemType Directory -Path dir\sub -Force` | `mkdir dir\sub` |
| `find /tmp -name '*.log'` | `Get-ChildItem -Path C:\temp -Filter '*.log' -Recurse` | `dir /S /B C:\temp\*.log` |
| `touch file.txt` | `New-Item -ItemType File -Path file.txt -Force` | `type nul > file.txt` |

## Text processing

| Bash | PowerShell |
|------|------------|
| `cat file.txt` | `Get-Content file.txt` |
| `grep 'error' file.log` | `Select-String -Path file.log -Pattern 'error'` |
| `grep -r 'error' dir/` | `Get-ChildItem dir\ -Recurse -File \| Select-String -Pattern 'error'` |
| `sed -i 's/foo/bar/g' file.txt` | `(Get-Content file.txt) -replace 'foo','bar' \| Set-Content file.txt -Encoding UTF8` |
| `awk '{print $1}' file.txt` | `Get-Content file.txt \| ForEach-Object { $_.Split()[0] }` |
| `wc -l file.txt` | `(Get-Content file.txt).Count` |
| `head -n 10 file.txt` | `Get-Content file.txt -TotalCount 10` |
| `tail -n 10 file.txt` | `Get-Content file.txt -Tail 10` |
| `sort file.txt` | `Get-Content file.txt \| Sort-Object` |
| `uniq` | `Get-Content file.txt \| Sort-Object -Unique` |
| `xargs -I {} cmd {}` | `Get-Content list.txt \| ForEach-Object { cmd $_ }` |

## Processes and services

| Bash | PowerShell | CMD |
|------|------------|-----|
| `ps aux` | `Get-Process` | `tasklist` |
| `kill 1234` | `Stop-Process -Id 1234 -WhatIf` | `taskkill /PID 1234 /F` |
| `killall notepad` | `Stop-Process -Name notepad -WhatIf` | `taskkill /IM notepad.exe /F` |
| `systemctl status spooler` | `Get-Service -Name Spooler` | `sc query Spooler` |
| `systemctl start spooler` | `Start-Service -Name Spooler -WhatIf` | `sc start Spooler` |
| `systemctl stop spooler` | `Stop-Service -Name Spooler -WhatIf` | `sc stop Spooler` |

## Networking

| Bash | PowerShell | CMD |
|------|------------|-----|
| `ping -c 4 8.8.8.8` | `Test-Connection -ComputerName 8.8.8.8 -Count 4` | `ping -n 4 8.8.8.8` |
| `curl https://api.example.com` | `Invoke-RestMethod -Uri https://api.example.com` | `curl` (if installed) |
| `wget https://example.com/file.zip` | `Invoke-RestMethod -Uri https://example.com/file.zip -OutFile file.zip` | `curl -O file.zip https://example.com/file.zip` |
| `nslookup example.com` | `Resolve-DnsName -Name example.com` | `nslookup example.com` |
| `ip addr` | `Get-NetIPConfiguration` | `ipconfig /all` |
| `netstat -tlnp` | `Get-NetTCPConnection -State Listen` | `netstat -ano` |

## Environment variables

| Bash | PowerShell | CMD |
|------|------------|-----|
| `echo $PATH` | `$env:PATH` | `echo %PATH%` |
| `export VAR=value` | `$env:VAR = 'value'` | `set VAR=value` |
| `export VAR=value` (persist) | `[Environment]::SetEnvironmentVariable('VAR', 'value', 'User')` | `setx VAR value` |

## Archives

| Bash | PowerShell | CMD |
|------|------------|-----|
| `tar -czf backup.tar.gz dir/` | `Compress-Archive -Path dir\ -DestinationPath backup.zip` | No native equivalent |
| `tar -xzf backup.tar.gz` | `Expand-Archive -Path backup.zip -DestinationPath .` | No native equivalent |

## Key differences to remember

1. **Paths**: PowerShell accepts `/` and `\`. CMD generally needs `\` or quoted paths.
2. **Quotes**: PowerShell single quotes are literal; double quotes expand variables. CMD double quotes group arguments.
3. **Variables**: PowerShell uses `$name`; CMD uses `%name%` (or `!name!` with delayed expansion).
4. **Pipelines**: PowerShell passes objects; bash and CMD pass text lines.
5. **Case**: PowerShell cmdlets are case-insensitive. CMD is mostly case-insensitive.
6. **Wildcards**: PowerShell uses `*`, `?`, and character ranges `[a-z]`. CMD uses `*` and `?`.

## When to stay in CMD

- Very old Windows without PowerShell.
- Boot/recovery environment.
- Minimal startup time requirement.
- Maintaining legacy `.bat` files.

For everything else, prefer PowerShell 7.
