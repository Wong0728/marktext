#!/usr/bin/env python3
"""One-click unpacked test build for MarkText.

Builds an unpacked (directory) version of MarkText using electron-builder
--dir, then launches it for testing. The output exe is at
dist-build-<timestamp>/win-unpacked/marktext.exe.

A fresh timestamped output directory is used for each build to avoid
EPERM/EBUSY errors when Windows Defender locks files from the previous
build's output.

Usage: python build_test.py
"""

import datetime
import glob
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

# Each build writes to a fresh timestamped directory. This avoids EPERM/EBUSY
# when Windows Defender locks files from the previous build's output and
# electron-builder cannot rename or delete them.
BUILD_TIMESTAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
OUTPUT_DIR_NAME = f"dist-build-{BUILD_TIMESTAMP}"
OUTPUT_DIR = REPO_ROOT / OUTPUT_DIR_NAME
EXE_PATH = OUTPUT_DIR / "win-unpacked" / "marktext.exe"


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


def cleanup_old_builds():
    """Best-effort cleanup of old dist-build-* directories.

    Non-fatal: directories locked by Windows Defender are skipped silently.
    Also tries to remove the legacy dist-clean/ directory.
    """
    print_header("Cleaning old build directories (best-effort)")

    targets = glob.glob(str(REPO_ROOT / "dist-build-*"))
    legacy = REPO_ROOT / "dist-clean"
    if legacy.exists():
        targets.append(str(legacy))

    if not targets:
        print("  (no old build directories found)")
        return

    cleaned = 0
    skipped = 0
    for path in targets:
        if Path(path) == OUTPUT_DIR:
            continue
        rc = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"Remove-Item -LiteralPath '{path}' -Recurse -Force -ErrorAction SilentlyContinue",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW,
        ).returncode
        if not Path(path).exists():
            cleaned += 1
        else:
            skipped += 1

    if cleaned + skipped > 0:
        msg = f"Cleaned {cleaned} old dir(s)"
        if skipped:
            msg += f", skipped {skipped} (locked by Defender — will clean later)"
        print_success(msg)


def main():
    print(f"{BOLD}MarkText Test Build (Unpacked){RESET}")
    print(f"  Repo root: {REPO_ROOT}")
    print(f"  Output:    {OUTPUT_DIR}")

    check_prerequisites()
    kill_running_marktext()
    cleanup_old_builds()

    steps = [
        (
            "pnpm exec tsx ../../scripts/minify-locales.ts",
            DESKTOP_DIR,
            "Step 1/4: Minifying locales",
        ),
        (
            "pnpm exec electron-rebuild",
            DESKTOP_DIR,
            "Step 2/4: Rebuilding native modules",
        ),
        (
            "pnpm exec electron-vite build",
            DESKTOP_DIR,
            "Step 3/4: Building with electron-vite",
        ),
        (
            # Use a fresh timestamped output directory to avoid EPERM when
            # Windows Defender locks files from the previous build.
            f"pnpm exec electron-builder --win --x64 --dir --publish never "
            f"--config.directories.output=../../{OUTPUT_DIR_NAME}",
            DESKTOP_DIR,
            "Step 4/4: Packaging (unpacked, no installer)",
        ),
    ]

    for cmd_str, cwd, label in steps:
        rc = run_step(cmd_str, cwd, label)
        if rc != 0:
            print_error("\nTest build failed.")
            sys.exit(1)

    if not EXE_PATH.exists():
        print_error(f"\nBuild reported success but exe not found at {EXE_PATH}")
        sys.exit(1)

    print_header("Build complete!")
    size_mb = EXE_PATH.stat().st_size / 1024 / 1024
    print_success(f"  Executable: {EXE_PATH}")
    print_success(f"  Size:       {size_mb:.1f} MB")

    print_header("Launching MarkText...")
    try:
        subprocess.Popen(
            [str(EXE_PATH)],
            cwd=str(EXE_PATH.parent),
        )
        print_success("MarkText launched. You can close this terminal.")
    except Exception as e:
        print_error(f"Failed to launch: {e}")
        print_error(f"You can run it manually: {EXE_PATH}")


if __name__ == "__main__":
    main()
