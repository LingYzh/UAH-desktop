# Active Directory Reference

## Prerequisites

- Windows Server with AD DS role, or a domain-joined client with RSAT installed.
- PowerShell module `ActiveDirectory` must be available.
- Most commands require domain credentials with sufficient permissions.

## Loading the module

```powershell
Import-Module ActiveDirectory
```

## Users

### Find users

```powershell
# Get a specific user
Get-ADUser -Identity jdoe

# Get specific properties
Get-ADUser -Identity jdoe -Properties DisplayName, EmailAddress, MemberOf

# Search by filter
Get-ADUser -Filter "Surname -eq 'Doe'" -Properties EmailAddress |
    Select-Object Name, SamAccountName, EmailAddress

# Search by LDAP filter
Get-ADUser -LDAPFilter '(department=IT)' -Properties Department
```

### Create user

```powershell
$securePassword = ConvertTo-SecureString -String 'P@ssw0rd!' -AsPlainText -Force
New-ADUser -Name 'John Doe' -SamAccountName 'jdoe' -UserPrincipalName 'jdoe@contoso.com' `
    -AccountPassword $securePassword -Enabled $true -Path 'OU=Users,DC=contoso,DC=com'
```

### Modify user

```powershell
Set-ADUser -Identity jdoe -EmailAddress 'jdoe@contoso.com' -Department 'Engineering'
```

### Disable / enable / unlock

```powershell
Disable-ADAccount -Identity jdoe
Enable-ADAccount -Identity jdoe
Unlock-ADAccount -Identity jdoe
```

## Groups

```powershell
# List groups
Get-ADGroup -Filter * | Select-Object Name, GroupCategory

# Get group members
Get-ADGroupMember -Identity 'IT-Department' | Select-Object Name, SamAccountName, objectClass

# Add member
Add-ADGroupMember -Identity 'IT-Department' -Members jdoe

# Remove member
Remove-ADGroupMember -Identity 'IT-Department' -Members jdoe -WhatIf
```

## Computers

```powershell
# Find computer accounts
Get-ADComputer -Filter "Name -like 'WS-*'" -Properties OperatingSystem

# Disable stale computer account
Get-ADComputer -Identity WS-OLD01 | Disable-ADAccount
```

## Organizational Units

```powershell
# List OUs
Get-ADOrganizationalUnit -Filter * | Select-Object Name, DistinguishedName

# Create OU
New-ADOrganizationalUnit -Name 'NewDepartment' -Path 'DC=contoso,DC=com'
```

## Domain and forest info

```powershell
Get-ADDomain
Get-ADForest
Get-ADDefaultDomainPasswordPolicy
```

## Elevation and credentials

```powershell
# Run with explicit credentials
$cred = Get-Credential
Get-ADUser -Identity jdoe -Credential $cred -Server dc01.contoso.com
```

## Safety notes

- Test in a lab before running in production.
- Use `-WhatIf` for `Set-ADUser`, `Remove-ADGroupMember`, `Move-ADObject`, etc.
- Passwords should never be hard-coded. Prompt with `Get-Credential` or use a secrets manager.
- Account creation and group membership changes may have licensing/security implications.
