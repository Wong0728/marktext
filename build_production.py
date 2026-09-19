#!/usr/bin/env python3
"""One-click production installer build for MarkText.

Runs `pnpm run build:win` to produce the NSIS installer (.exe) and
portable zip (.zip) in the dist/ directory.

Usage: python build_production.py
"""

import shutil
import subprocess
import sys
from pathlib import Path

BLUE = "\033[94m"
GREEN = "\033[92m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"

REPO_ROOT = Path(__file__).resolve().parent
DESKTOP_DIR = REPO_ROOT / "packages" / "desktop"
DIST_DIR = REPO_ROOT / "dist"
VERSION = "0.20.0-dev"


def print_header(msg):
    print(f"\n{BOLD}{BLUE}>>> {msg}{RESET}")


def print_success(msg):
    print(f"{GREEN}{msg}{RESET}")


def print_error(msg):
    print(f"{RED}{msg}{RESET}", file=sys.stderr)


def check_prerequisites():
    print_header("Checking prerequisites")

    missing = []
    for cmd in ("node", "pnpm"):
        if not shutil.which(cmd):
            missing.append(cmd)

    if missing:
        print_error(f"Missing commands: {', '.join(missing)}")
        print_error("Please install Node.js (>= 20.19.0) and pnpm (>= 10) first.")
        sys.exit(1)

    if not (REPO_ROOT / "node_modules").is_dir():
        print_error("node_modules/ not found. Run 'pnpm install' first.")
        sys.exit(1)

    if not DESKTOP_DIR.is_dir():
        print_error(f"packages/desktop/ not found at {DESKTOP_DIR}")
        sys.exit(1)

    print_success("Prerequisites OK")


def run_step(cmd_str, cwd, label):
    print_header(label)
    print(f"  Command: {cmd_str}")
    print(f"  Working directory: {cwd}\n")

    process = subprocess.Popen(
        cmd_str,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        bufsize=1,
        shell=True,
    )

    for line in process.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()

    return_code = process.wait()

    if return_code != 0:
        print_error(f"\nFailed: {label} (exit code {return_code})")

    return return_code


def kill_running_marktext():
    """Kill any running marktext.exe so app.asar can be overwritten."""
    import time

    print_header("Stopping any running MarkText instance")

    # First attempt: taskkill by image name
    result = subprocess.run(
        ["taskkill", "/IM", "marktext.exe", "/F", "/T"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )

    # Give the process a moment to fully release app.asar
    time.sleep(2)

    # Second attempt via PowerShell if it is still around
    ps_result = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "Stop-Process -Name marktext -Force -ErrorAction SilentlyContinue",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )

    if result.returncode == 0 or ps_result.returncode == 0:
        print_success("Stopped running MarkText instance(s)")
    else:
        # 128 = no matching process found; that's fine
        print("  (no running instance found)")


def main():
    print(f"{BOLD}MarkText Production Build{RESET}")
    print(f"  Repo root: {REPO_ROOT}")

    check_prerequisites()
    kill_running_marktext()

    rc = run_step(
        "pnpm run build:win",
        cwd=REPO_ROOT,
        label="Building production installer (pnpm run build:win)",
    )

    if rc != 0:
        print_error("\nProduction build failed.")
        sys.exit(1)

    installer = DIST_DIR / f"marktext-win-x64-{VERSION}-setup.exe"
    zip_file = DIST_DIR / f"marktext-win-x64-{VERSION}.zip"

    print_header("Build complete!")
    if installer.exists():
        size_mb = installer.stat().st_size / 1024 / 1024
        print_success(f"  Installer: {installer}")
        print_success(f"  Size:      {size_mb:.1f} MB")
    else:
        print_error(f"  Installer not found: {installer}")

    if zip_file.exists():
        size_mb = zip_file.stat().st_size / 1024 / 1024
        print_success(f"  Zip:       {zip_file}")
        print_success(f"  Size:      {size_mb:.1f} MB")
    else:
        print_error(f"  Zip not found: {zip_file}")


if __name__ == "__main__":
    main()
