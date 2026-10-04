#!/usr/bin/env python3
"""
Lightweight static checker for PowerShell code.

This script does NOT execute PowerShell. It performs text-level checks for:
- Dangerous cmdlets that should use -WhatIf
- Deprecated aliases and WMI cmdlets
- Overly permissive execution policies
- Missing error handling patterns
- Suspicious path/quoting issues
- Risky console/code-page and native encoding changes

Limitations: this is regex-based preflight linting, not semantic analysis. It cannot
detect obfuscated code, runtime values, or AST-level issues. Use PSScriptAnalyzer
(Invoke-ScriptAnalyzer) when available for deeper analysis.

Usage:
    python validate_ps.py -c "Get-Process | Stop-Process"
    python validate_ps.py -f script.ps1
    python validate_ps.py -c "..." --json
"""

import argparse
import json
import re
import sys
from pathlib import Path


DANGEROUS_CMDLETS = {
    "Remove-Item": ["-WhatIf", "-Confirm"],
    "Remove-Computer": ["-WhatIf", "-Confirm"],
    "Clear-EventLog": ["-WhatIf", "-Confirm"],
    "Clear-RecycleBin": ["-WhatIf", "-Confirm"],
    "Clear-Content": ["-WhatIf", "-Confirm"],
    "Format-Volume": ["-WhatIf", "-Confirm"],
    "Initialize-Disk": ["-WhatIf", "-Confirm"],
    "Dismount-Volume": ["-WhatIf", "-Confirm"],
    "Repair-Volume": ["-WhatIf", "-Confirm"],
    "Optimize-Volume": ["-WhatIf", "-Confirm"],
    "Stop-Service": ["-WhatIf", "-Confirm"],
    "Restart-Service": ["-WhatIf", "-Confirm"],
    "Restart-Computer": ["-WhatIf", "-Confirm"],
    "Stop-Process": ["-WhatIf", "-Confirm"],
    "Move-Item": ["-WhatIf", "-Confirm"],
    "Rename-Item": ["-WhatIf", "-Confirm"],
    "Remove-ItemProperty": ["-WhatIf", "-Confirm"],
    "Remove-ADUser": ["-WhatIf", "-Confirm"],
    "Remove-ADGroup": ["-WhatIf", "-Confirm"],
    "Remove-ADComputer": ["-WhatIf", "-Confirm"],
    "Set-ExecutionPolicy": ["-WhatIf", "-Confirm"],
    "Unregister-ScheduledTask": ["-WhatIf", "-Confirm"],
}

RISKY_EXECUTION_POLICIES = {"Unrestricted", "Bypass"}

DEPRECATED_ALIASES = {
    "ls": "Get-ChildItem",
    "dir": "Get-ChildItem",
    "cd": "Set-Location",
    "rm": "Remove-Item",
    "rmdir": "Remove-Item",
    "cp": "Copy-Item",
    "mv": "Move-Item",
    "cat": "Get-Content",
    "type": "Get-Content",
    "echo": "Write-Output",
    "?": "Where-Object",
    "%": "ForEach-Object",
    "sort": "Sort-Object",
    "select": "Select-Object",
    "where": "Where-Object",
    "foreach": "ForEach-Object",
}

DEPRECATED_CMDLETS = [
    "Get-WmiObject",
    "Invoke-WmiMethod",
    "Register-WmiEvent",
    "Remove-WmiObject",
    "Set-WmiInstance",
]

SUSPICIOUS_PATTERNS = [
    (r"Invoke-Expression", "Invoke-Expression can execute arbitrary code; prefer safer alternatives"),
    (r"-EncodedCommand", "Encoded commands can hide malicious payloads; verify the source"),
    (r"DownloadString\s*\(", "Downloading and executing code from the internet is dangerous"),
    (r"DownloadFile\s*\(", "Downloading files from the internet requires validation"),
]

READONLY_CMDLETS = {
    "Get-ChildItem", "Get-Content", "Get-Process", "Get-Service", "Get-Item",
    "Get-ItemProperty", "Get-WinEvent", "Get-CimInstance", "Get-NetAdapter",
    "Test-Path", "Test-Connection", "Test-NetConnection", "Select-String",
    "Where-Object", "Select-Object", "Sort-Object", "Format-Table", "Format-List",
    "Write-Host", "Write-Output", "Write-Information", "Write-Verbose", "Write-Debug",
}

MUTATING_CMDLET_PREFIXES = (
    "Remove", "Stop", "Restart", "Start", "Set", "New", "Add", "Move", "Rename",
    "Clear", "Format", "Initialize", "Dismount", "Repair", "Optimize", "Unregister",
)


def normalize_pipeline(code: str) -> str:
    """Collapse pipeline continuations so downstream cmdlets keep context."""
    # Normalize line continuations with backtick first.
    collapsed = re.sub(r"`\s*\n\s*", " ", code)
    # Keep pipelines on a single logical line.
    return re.sub(r"\s*\|\s*\n\s*", " | ", collapsed)


def has_whatif_or_confirm(segment: str) -> bool:
    """Check whether a cmdlet invocation segment has -WhatIf or -Confirm."""
    return "-WhatIf" in segment or "-Confirm" in segment


def check_dangerous_cmdlets(code: str) -> list[dict]:
    """Find dangerous cmdlets missing -WhatIf/-Confirm."""
    normalized = normalize_pipeline(code)
    findings = []
    for line_no, line in enumerate(normalized.splitlines(), start=1):
        for cmdlet in DANGEROUS_CMDLETS:
            for match in re.finditer(rf"\b{re.escape(cmdlet)}\b", line):
                segment = line[match.start():]
                if not has_whatif_or_confirm(segment):
                    findings.append(
                        {
                            "line": line_no,
                            "line_text": line.strip(),
                            "type": "dangerous_cmdlet",
                            "message": (
                                f"{cmdlet} is destructive. "
                                f"Consider adding -WhatIf or -Confirm."
                            ),
                        }
                    )
    return findings


def check_execution_policy(code: str) -> list[dict]:
    """Flag overly permissive Set-ExecutionPolicy recommendations."""
    findings = []
    for line_no, line in enumerate(code.splitlines(), start=1):
        if not re.search(r"\bSet-ExecutionPolicy\b", line):
            continue
        match = re.search(r"-ExecutionPolicy\s+(\w+)", line)
        if match and match.group(1) in RISKY_EXECUTION_POLICIES:
            findings.append(
                {
                    "line": line_no,
                    "line_text": line.strip(),
                    "type": "risky_execution_policy",
                    "message": (
                        f"{match.group(1)} is an overly permissive execution policy. "
                        "Prefer RemoteSigned for a scope, or use -ExecutionPolicy Bypass "
                        "for a single invocation only."
                    ),
                }
            )
    return findings


def check_deprecated_aliases(code: str) -> list[dict]:
    """Find aliases that should be expanded in scripts."""
    findings = []
    for line_no, line in enumerate(code.splitlines(), start=1):
        # Skip comment lines.
        if line.strip().startswith("#"):
            continue
        for alias, full in DEPRECATED_ALIASES.items():
            # Aliases like ? and % are not word characters, so \b logic fails.
            # Match the alias as a token followed by optional whitespace and
            # either a block '{', pipeline '|', end-of-string, or word boundary.
            pattern = rf"(^|[^\w`])({re.escape(alias)})(\s*(\{{|\||\)|\r|\n|$)|\b)"
            if re.search(pattern, line):
                findings.append(
                    {
                        "line": line_no,
                        "line_text": line.strip(),
                        "type": "deprecated_alias",
                        "message": f"Alias '{alias}' is ambiguous in scripts; use '{full}' instead.",
                    }
                )
    return findings


def check_deprecated_cmdlets(code: str) -> list[dict]:
    """Find deprecated WMI cmdlets."""
    findings = []
    for line_no, line in enumerate(code.splitlines(), start=1):
        for cmdlet in DEPRECATED_CMDLETS:
            if re.search(rf"\b{re.escape(cmdlet)}\b", line):
                findings.append(
                    {
                        "line": line_no,
                        "line_text": line.strip(),
                        "type": "deprecated_cmdlet",
                        "message": f"{cmdlet} is deprecated; use Get-CimInstance / CIM cmdlets instead.",
                    }
                )
    return findings


def _contains_mutating_cmdlet(code: str) -> bool:
    """Return True if code appears to mutate state."""
    pattern = rf"\b({'|'.join(MUTATING_CMDLET_PREFIXES)})-[A-Z]\w+\b"
    return bool(re.search(pattern, code))


def check_error_handling(code: str) -> list[dict]:
    """Check for basic error handling patterns on non-trivial/mutating scripts."""
    findings = []
    has_error_action_pref = re.search(
        r"\$ErrorActionPreference\s*=\s*['\"]Stop['\"]", code, re.IGNORECASE
    )
    has_try_catch = re.search(r"\btry\b", code, re.IGNORECASE) and re.search(
        r"\bcatch\b", code, re.IGNORECASE
    )
    has_error_action_param = re.search(r"-ErrorAction\s+Stop", code, re.IGNORECASE)

    lines = [line.strip() for line in code.splitlines()]
    code_lines = [
        line for line in lines
        if line and not line.startswith("#") and not line.startswith("<#")
    ]

    if not code_lines:
        return findings

    # Trivial: one or two lines with no mutating cmdlets are usually fine without explicit error handling.
    if len(code_lines) <= 2 and not _contains_mutating_cmdlet(code):
        return findings

    # If the script is purely read-only, explicit error handling is recommended but not warned.
    joined = " ".join(code_lines)
    all_tokens = re.findall(r"\b[A-Z]\w+-[A-Z]\w+\b", joined)
    if all_tokens and all(token in READONLY_CMDLETS for token in all_tokens):
        return findings

    if not (has_error_action_pref or has_try_catch or has_error_action_param):
        findings.append(
            {
                "line": None,
                "line_text": None,
                "type": "missing_error_handling",
                "message": (
                    "No explicit error handling found. "
                    "Consider setting $ErrorActionPreference = 'Stop', using try/catch, "
                    "or adding -ErrorAction Stop to critical cmdlets."
                ),
            }
        )
    return findings


def check_suspicious_patterns(code: str) -> list[dict]:
    """Find patterns that are often risky."""
    findings = []
    for line_no, line in enumerate(code.splitlines(), start=1):
        for pattern, message in SUSPICIOUS_PATTERNS:
            if re.search(pattern, line, re.IGNORECASE):
                findings.append(
                    {
                        "line": line_no,
                        "line_text": line.strip(),
                        "type": "suspicious_pattern",
                        "message": message,
                    }
                )
    return findings


def check_quoting(code: str) -> list[dict]:
    """Lightweight check for obviously unbalanced quotes on lines with path parameters."""
    findings = []
    path_param_re = re.compile(r"\s-(Path|FilePath|LiteralPath|Destination|Source)\s+")
    for line_no, line in enumerate(code.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if not path_param_re.search(stripped):
            continue
        single = stripped.count("'")
        double = stripped.count('"')
        if single % 2 != 0 or double % 2 != 0:
            findings.append(
                {
                    "line": line_no,
                    "line_text": stripped,
                    "type": "potential_quote_issue",
                    "message": "Line contains a path parameter and has unbalanced quotes; verify quoting.",
                }
            )
    return findings



def check_encoding_changes(code: str) -> list[dict]:
    """Warn about broad encoding changes that are easy to misuse on Windows."""
    findings = []

    for line_no, line in enumerate(code.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue

        if re.search(r"\bchcp(?:\.com)?\s+\d+", stripped, re.IGNORECASE):
            findings.append(
                {
                    "line": line_no,
                    "line_text": stripped,
                    "type": "console_code_page_change",
                    "message": (
                        "chcp changes the active console code page only. "
                        "Do not use it as a universal fix for file or native-tool encoding."
                    ),
                }
            )

    changes_output_encoding = bool(
        re.search(r"\$OutputEncoding\s*=", code, re.IGNORECASE)
    )
    saves_output_encoding = bool(
        re.search(r"\$\w*OutputEncoding\w*\s*=\s*\$OutputEncoding", code, re.IGNORECASE)
    )
    restores_in_finally = bool(
        re.search(
            r"finally\s*\{[\s\S]*?\$OutputEncoding\s*=\s*\$\w*OutputEncoding\w*",
            code,
            re.IGNORECASE,
        )
    )

    if changes_output_encoding and not (saves_output_encoding and restores_in_finally):
        findings.append(
            {
                "line": None,
                "line_text": None,
                "type": "unscoped_output_encoding_change",
                "message": (
                    "$OutputEncoding controls PowerShell -> native stdin encoding. "
                    "Scope temporary changes and restore the previous value in finally."
                ),
            }
        )

    changes_console_encoding = bool(
        re.search(
            r"\[Console\]::(?:InputEncoding|OutputEncoding)\s*=",
            code,
            re.IGNORECASE,
        )
    )
    if changes_console_encoding and "finally" not in code.lower():
        findings.append(
            {
                "line": None,
                "line_text": None,
                "type": "unscoped_console_encoding_change",
                "message": (
                    "Changing Console InputEncoding/OutputEncoding is session state. "
                    "Prefer a narrow, reversible change tied to a known native protocol."
                ),
            }
        )

    if re.search(
        r"\$PSDefaultParameterValues\s*\[[^\]]*Encoding[^\]]*\]\s*=",
        code,
        re.IGNORECASE,
    ):
        findings.append(
            {
                "line": None,
                "line_text": None,
                "type": "global_encoding_default_change",
                "message": (
                    "Changing $PSDefaultParameterValues for Encoding can affect many commands. "
                    "Prefer explicit per-boundary encoding unless a session-wide policy is intentional."
                ),
            }
        )

    return findings


def check_native_invocation_risks(code: str) -> list[dict]:
    """Warn about fragile native-command boundaries and parser layering."""
    findings = []

    for line_no, line in enumerate(code.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if re.search(r"\bStart-Process\b.*-ArgumentList\b", stripped, re.IGNORECASE):
            findings.append(
                {
                    "line": line_no,
                    "line_text": stripped,
                    "type": "start_process_argumentlist_boundary",
                    "message": (
                        "Start-Process -ArgumentList is joined into a command-line string. "
                        "Do not assume array values preserve argv boundaries; verify target quoting."
                    ),
                }
            )

        if re.search(r"\bcmd(?:\.exe)?\s+/[cC]\b", stripped) and "$" in stripped:
            findings.append(
                {
                    "line": line_no,
                    "line_text": stripped,
                    "type": "dynamic_cmd_c_boundary",
                    "message": (
                        "Dynamic PowerShell values are crossing into cmd /c string parsing. "
                        "Prefer direct native invocation or a structured API when possible."
                    ),
                }
            )

        stop_index = stripped.find("--%")
        if stop_index >= 0:
            remainder = stripped[stop_index + 3 :]
            if "$" in remainder or "$(" in remainder:
                findings.append(
                    {
                        "line": line_no,
                        "line_text": stripped,
                        "type": "dynamic_stop_parsing_usage",
                        "message": (
                            "--% stops normal PowerShell parsing. PowerShell variables and "
                            "subexpressions after it won't behave like ordinary dynamic arguments."
                        ),
                    }
                )

    changes_native_passing = bool(
        re.search(r"\$PSNativeCommandArgumentPassing\s*=", code, re.IGNORECASE)
    )
    if changes_native_passing and "finally" not in code.lower():
        findings.append(
            {
                "line": None,
                "line_text": None,
                "type": "unscoped_native_argument_mode_change",
                "message": (
                    "Changing $PSNativeCommandArgumentPassing changes session native-argument "
                    "semantics. Prefer the default or scope and restore intentional overrides."
                ),
            }
        )

    if re.search(r"\bpwsh(?:\.exe)?\b.*\s-Command\b", code, re.IGNORECASE):
        findings.append(
            {
                "line": None,
                "line_text": None,
                "type": "nested_pwsh_command_string",
                "message": (
                    "Nested pwsh -Command adds another PowerShell parser layer. "
                    "Prefer -File with parameters for reusable or complex dynamic input."
                ),
            }
        )

    return findings

def validate(code: str) -> dict:
    """Run all checks and return a structured report."""
    findings = []
    findings.extend(check_dangerous_cmdlets(code))
    findings.extend(check_execution_policy(code))
    findings.extend(check_deprecated_aliases(code))
    findings.extend(check_deprecated_cmdlets(code))
    findings.extend(check_error_handling(code))
    findings.extend(check_suspicious_patterns(code))
    findings.extend(check_quoting(code))
    findings.extend(check_encoding_changes(code))
    findings.extend(check_native_invocation_risks(code))

    dangerous = [f for f in findings if f["type"] == "dangerous_cmdlet"]

    safe = not dangerous and not any(
        f["type"] in {"suspicious_pattern", "risky_execution_policy"} for f in findings
    )

    return {
        "safe": safe,
        "dangerous_operations": dangerous,
        "warnings": [f for f in findings if f["type"] != "dangerous_cmdlet"],
        "total_findings": len(findings),
    }


def print_report(report: dict, fmt: str = "markdown") -> None:
    """Print the validation report."""
    if fmt == "json":
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return

    status = "✅ SAFE" if report["safe"] else "⚠️  REVIEW REQUIRED"
    print(f"# PowerShell Static Check: {status}\n")

    if report["dangerous_operations"]:
        print("## Dangerous operations")
        for item in report["dangerous_operations"]:
            print(f"- Line {item['line']}: {item['message']}")
            print(f"  `{item['line_text']}`")
        print()

    if report["warnings"]:
        print("## Warnings")
        for item in report["warnings"]:
            line = item["line"] if item["line"] else "-"
            print(f"- Line {line}: {item['message']}")
            if item["line_text"]:
                print(f"  `{item['line_text']}`")
        print()

    if report["safe"] and not report["warnings"]:
        print("No issues found.")

    print(f"\nTotal findings: {report['total_findings']}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Lightweight static checker for PowerShell code."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("-c", "--code", help="PowerShell code to validate")
    group.add_argument("-f", "--file", help="Path to a .ps1 file")
    parser.add_argument(
        "--json", action="store_true", help="Output raw JSON report"
    )
    args = parser.parse_args()

    if args.file:
        path = Path(args.file)
        if not path.exists():
            print(f"File not found: {path}", file=sys.stderr)
            return 1
        code = path.read_text(encoding="utf-8")
    else:
        code = args.code

    report = validate(code)
    print_report(report, fmt="json" if args.json else "markdown")

    return 0 if report["safe"] else 2


if __name__ == "__main__":
    sys.exit(main())
