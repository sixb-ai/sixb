"""Python/pip regression: replace scripts/python3 with a symlink to the venv interpreter and
rebuild; pip and python3 then target different environments and this check fails."""

import subprocess
import sys
import zipfile
from pathlib import Path


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise AssertionError(f"{args}: {result.stderr or result.stdout}")
    return result.stdout.strip()


def check_python_environment(root):
    expected = command("python3", "-m", "pip", "--version")
    assert command("pip", "--version") == expected, "pip and python3 target different environments"
    assert command("pip3", "--version") == expected
    assert command("python", "-m", "pip", "--version") == expected

    # Install a real offline wheel as the sandbox user; an import-only test misses permissions.
    wheel = root / "sixb_image_fixture-1.0-py3-none-any.whl"
    prefix = "sixb_image_fixture-1.0.dist-info"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("sixb_image_fixture.py", "VALUE = 2450\n")
        archive.writestr(f"{prefix}/METADATA", "Metadata-Version: 2.1\nName: sixb-image-fixture\nVersion: 1.0\n")
        archive.writestr(f"{prefix}/WHEEL", "Wheel-Version: 1.0\nGenerator: sixb-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        archive.writestr(f"{prefix}/RECORD", "")
    command("pip", "install", "--no-index", "--no-deps", "--no-cache-dir", str(wheel))
    for executable in ("python", "python3"):
        assert command(executable, "-c", "from sixb_image_fixture import VALUE; print(VALUE)") == "2450"
    command("python3", "-m", "pip", "uninstall", "-y", "sixb-image-fixture")

    isolated = root / "venv"
    command("uv", "venv", "--no-python-downloads", "--python", sys.executable, str(isolated))
    command("uv", "pip", "install", "--no-index", "--no-cache", "--python", str(isolated / "bin/python"), str(wheel))
    assert command(str(isolated / "bin/python"), "-c", "from sixb_image_fixture import VALUE; print(VALUE)") == "2450"
    # The environment is evidence, not a deliverable; avoid archiving a second Python runtime.
    import shutil
    shutil.rmtree(isolated)

