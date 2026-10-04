# Networking Reference

## Connectivity tests

### PowerShell

```powershell
# ICMP ping
Test-Connection -ComputerName 8.8.8.8 -Count 4

# TCP port test
Test-NetConnection -ComputerName example.com -Port 443

# DNS resolution
Resolve-DnsName -Name example.com

# Get IP configuration
Get-NetIPConfiguration

# List network adapters
Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
```

### CMD

```batch
ping -n 4 8.8.8.8
ping -n 4 example.com
nslookup example.com
ipconfig /all
netsh interface show interface
```

## Adapter management

### PowerShell

```powershell
# Disable/enable adapter
Disable-NetAdapter -Name 'Wi-Fi' -Confirm:$false
Enable-NetAdapter -Name 'Wi-Fi'

# Set static IP (requires elevation)
New-NetIPAddress -InterfaceAlias 'Ethernet' -IPAddress 192.168.1.10 -PrefixLength 24 -DefaultGateway 192.168.1.1
Set-DnsClientServerAddress -InterfaceAlias 'Ethernet' -ServerAddresses ('192.168.1.1','8.8.8.8')

# Set DHCP
Set-NetIPInterface -InterfaceAlias 'Ethernet' -Dhcp Enabled
Set-DnsClientServerAddress -InterfaceAlias 'Ethernet' -ResetServerAddresses
```

### CMD

```batch
netsh interface ip set address "Ethernet" static 192.168.1.10 255.255.255.0 192.168.1.1
netsh interface ip set dns "Ethernet" static 192.168.1.1
netsh interface ip set address "Ethernet" dhcp
```

## Firewall

### PowerShell

```powershell
# List firewall rules
Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' } | Select-Object DisplayName, Direction, Action

# Open a port
New-NetFirewallRule -DisplayName 'Allow Port 8080' -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow

# Remove a rule
Remove-NetFirewallRule -DisplayName 'Allow Port 8080' -WhatIf
```

### CMD

```batch
netsh advfirewall firewall show rule name=all
netsh advfirewall firewall add rule name="Allow Port 8080" dir=in action=allow protocol=TCP localport=8080
netsh advfirewall firewall delete rule name="Allow Port 8080"
```

## Routing

### PowerShell

```powershell
Get-NetRoute
```

### CMD

```batch
route print
route add 10.0.0.0 mask 255.0.0.0 192.168.1.1
```

## Windows Firewall profiles

```powershell
Get-NetFirewallProfile
Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True
```

## Listening ports

### PowerShell

```powershell
Get-NetTCPConnection -State Listen |
    Select-Object LocalAddress, LocalPort, OwningProcess,
        @{N='ProcessName';E={(Get-Process -Id $_.OwningProcess).Name}}
```

### CMD

```batch
netstat -ano | findstr LISTENING
```

## Elevation notes

- Changing IP addresses, firewall rules, and routing typically requires administrator rights.
- `Test-NetConnection` works without elevation; `New-NetFirewallRule` requires elevation.
