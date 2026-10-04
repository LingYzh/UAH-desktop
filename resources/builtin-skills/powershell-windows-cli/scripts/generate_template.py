#!/usr/bin/env python3
"""
Generate common PowerShell / CMD command templates from user intent and parameters.

Usage:
    python generate_template.py list-services --status stopped --start-type automatic
    python generate_template.py query-events --log System --level Error --hours 24
    python generate_template.py registry-read --hive HKLM --path "SOFTWARE\\Microsoft" --name ReleaseId
    python generate_template.py copy-files --source "C:\\temp" --destination "C:\\backup" --pattern "*.log"
    python generate_template.py test-port --host example.com --port 443
    python generate_template.py --list
"""

import argparse
import json
import sys
from typing import Callable


TemplateFn = Callable[..., str]


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

def ps_literal(value: str) -> str:
    """Return a single-quoted PowerShell string literal, escaping embedded quotes."""
    return "'" + str(value).replace("'", "''") + "'"


def validate_hive(hive: str) -> str:
    allowed = {"HKCR", "HKCU", "HKLM", "HKU", "HKCC", "HKPD", "HKDD"}
    upper = hive.upper()
    if upper not in allowed:
        raise ValueError(f"Invalid registry hive: {hive!r}. Allowed: {sorted(allowed)}")
    return upper


# -----------------------------------------------------------------------------
# Templates
# -----------------------------------------------------------------------------

def list_services(status: str | None = None, start_type: str | None = None, **_) -> str:
    """Generate a PowerShell command to list services."""
    filters = []
    if status:
        filters.append(f"$_.Status -eq {ps_literal(status)}")
    if start_type:
        filters.append(f"$_.StartType -eq {ps_literal(start_type)}")

    if filters:
        where = " | Where-Object { " + " -and ".join(filters) + " }"
    else:
        where = ""

    return f"Get-Service{where} | Select-Object Name, Status, StartType"


def query_events(log: str = "System", level: str | None = None, hours: int = 24, **_) -> str:
    """Generate a PowerShell command to query event logs."""
    level_map = {
        "Critical": 1,
        "Error": 2,
        "Warning": 3,
        "Information": 4,
        "Verbose": 5,
    }
    if level and level not in level_map:
        raise ValueError(f"Invalid event level: {level!r}. Allowed: {list(level_map)}")
    if hours < 0:
        raise ValueError("hours must be non-negative")

    filter_ht = {
        "LogName": ps_literal(log),
        "StartTime": "(Get-Date).AddHours(-{0})".format(hours),
    }
    if level:
        filter_ht["Level"] = level_map[level]

    pairs = [f"{k}={v}" for k, v in filter_ht.items()]
    return (
        f"Get-WinEvent -FilterHashtable @{{{'; '.join(pairs)}}} | "
        f"Select-Object TimeCreated, Id, LevelDisplayName, Message"
    )


def registry_read(hive: str = "HKLM", path: str = "", name: str | None = None, **_) -> str:
    """Generate a PowerShell command to read a registry value."""
    hive = validate_hive(hive)
    ps_path = ps_literal(f"{hive}:{path}")
    if name:
        return f"Get-ItemProperty -Path {ps_path} -Name {ps_literal(name)}"
    return f"Get-ItemProperty -Path {ps_path}"


def registry_write(
    hive: str = "HKCU",
    path: str = "",
    name: str = "",
    value: str = "",
    type_: str = "String",
    **_,
) -> str:
    """Generate PowerShell commands to write a registry value."""
    hive = validate_hive(hive)
    ps_path = ps_literal(f"{hive}:{path}")
    type_map = {
        "String": "String",
        "DWord": "DWord",
        "QWord": "QWord",
        "Binary": "Binary",
        "MultiString": "MultiString",
        "ExpandString": "ExpandString",
    }
    if type_ not in type_map:
        raise ValueError(f"Invalid registry value type: {type_!r}. Allowed: {list(type_map)}")
    ps_type = type_map[type_]
    lines = [
        f"New-Item -Path {ps_path} -Force",
        f"Set-ItemProperty -Path {ps_path} -Name {ps_literal(name)} -Value {ps_literal(value)} -Type {ps_type}",
    ]
    return "\n".join(lines)


def copy_files(
    source: str = "",
    destination: str = "",
    pattern: str = "*",
    recurse: bool = False,
    **_,
) -> str:
    """Generate a PowerShell command to copy files."""
    flags = ""
    if recurse:
        flags += " -Recurse"
    return (
        f"Copy-Item -Path (Join-Path -Path {ps_literal(source)} -ChildPath {ps_literal(pattern)}) "
        f"-Destination {ps_literal(destination)}{flags} -WhatIf"
    )


def test_port(host: str = "localhost", port: int = 80, **_) -> str:
    """Generate a PowerShell command to test a TCP port."""
    if not (1 <= port <= 65535):
        raise ValueError(f"Invalid port: {port}. Must be 1-65535.")
    return f"Test-NetConnection -ComputerName {ps_literal(host)} -Port {port}"


def test_connection(host: str = "localhost", count: int = 4, **_) -> str:
    """Generate a PowerShell command to test ICMP connectivity."""
    if count < 1:
        raise ValueError("count must be at least 1")
    return f"Test-Connection -ComputerName {ps_literal(host)} -Count {count}"


TEMPLATES: dict[str, TemplateFn] = {
    "list-services": list_services,
    "query-events": query_events,
    "registry-read": registry_read,
    "registry-write": registry_write,
    "copy-files": copy_files,
    "test-port": test_port,
    "test-connection": test_connection,
}


# -----------------------------------------------------------------------------
# CMD equivalents
# -----------------------------------------------------------------------------

def to_cmd(template_name: str, params: dict) -> str | None:
    """Provide a CMD equivalent for supported templates."""
    if template_name == "test-connection":
        return f"ping -n {params.get('count', 4)} {params.get('host', 'localhost')}"

    if template_name == "test-port":
        return (
            ":: TCP port test requires PowerShell or a third-party tool; "
            "CMD has no built-in equivalent"
        )

    if template_name == "copy-files":
        src = params.get("source", "")
        dst = params.get("destination", "")
        pattern = params.get("pattern", "*")
        recurse = "/S " if params.get("recurse") else ""
        return f'xcopy "{src}\\{pattern}" "{dst}\\" /I {recurse}'.strip()

    if template_name == "list-services":
        parts = ["type= service"]
        if params.get("status"):
            parts.append(f"state= {params['status']}")
        # sc query supports type= and state= only; start-type filtering is a PowerShell job.
        return f"sc query {' '.join(parts)}"

    return None


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

def list_templates() -> str:
    """Return a markdown list of available templates."""
    lines = ["# Available templates\n"]
    for name, fn in TEMPLATES.items():
        doc = (fn.__doc__ or "").splitlines()[0]
        lines.append(f"- `{name}` — {doc}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate PowerShell/CMD command templates from intent and parameters."
    )
    parser.add_argument(
        "template",
        nargs="?",
        help="Template name (use --list to see options)",
    )
    parser.add_argument(
        "--list", action="store_true", help="List available templates"
    )
    parser.add_argument(
        "--json", action="store_true", help="Output raw JSON"
    )
    parser.add_argument(
        "--cmd", action="store_true", help="Generate CMD equivalent where possible"
    )
    parser.add_argument(
        "--params",
        help="JSON object with template parameters",
    )
    # Common parameters accepted directly as CLI flags for convenience.
    parser.add_argument("--status", help="Service status filter")
    parser.add_argument("--start-type", dest="start_type", help="Service start type filter")
    parser.add_argument("--log", help="Event log name")
    parser.add_argument("--level", help="Event level")
    parser.add_argument("--hours", type=int, help="Hours back for event query")
    parser.add_argument("--hive", help="Registry hive (HKLM, HKCU, etc.)")
    parser.add_argument("--path", help="Registry path or file path")
    parser.add_argument("--name", help="Registry value name")
    parser.add_argument("--value", help="Registry value")
    parser.add_argument("--type", dest="type_", help="Registry value type")
    parser.add_argument("--source", help="Source directory")
    parser.add_argument("--destination", help="Destination directory")
    parser.add_argument("--pattern", help="File pattern")
    parser.add_argument("--recurse", action="store_true", help="Recurse into subdirectories")
    parser.add_argument("--host", help="Host for network tests")
    parser.add_argument("--port", type=int, help="TCP port")
    parser.add_argument("--count", type=int, help="Ping count")
    return parser


def generate(template_name: str, params: dict, cmd_mode: bool = False) -> dict:
    """Generate output for the requested template."""
    if template_name not in TEMPLATES:
        raise ValueError(f"Unknown template: {template_name}")

    ps_code = TEMPLATES[template_name](**params)

    result = {
        "template": template_name,
        "powershell": ps_code,
    }

    if cmd_mode:
        result["cmd"] = to_cmd(template_name, params)

    return result


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.list:
        print(list_templates())
        return 0

    if not args.template:
        parser.print_help()
        return 1

    # Build parameters from CLI flags and/or JSON.
    params: dict = {}
    if args.params:
        try:
            params = json.loads(args.params)
        except json.JSONDecodeError as exc:
            print(f"Invalid JSON in --params: {exc}", file=sys.stderr)
            return 1

    for key, value in vars(args).items():
        if value is None or key in {"template", "list", "json", "cmd", "params"}:
            continue
        # Map CLI names to template parameter names.
        param_name = "type_" if key == "type_" else key
        params.setdefault(param_name, value)

    try:
        result = generate(args.template, params, cmd_mode=args.cmd)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0

    print(f"# Template: {result['template']}\n")
    print("## PowerShell")
    print("```powershell")
    print(result["powershell"])
    print("```")
    if result.get("cmd"):
        print("\n## CMD equivalent")
        print("```batch")
        print(result["cmd"])
        print("```")

    return 0


if __name__ == "__main__":
    sys.exit(main())
