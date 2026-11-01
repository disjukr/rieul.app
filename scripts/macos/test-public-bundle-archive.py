#!/usr/bin/env python3
"""Root-owned archive fixture only: never installs or changes the source app.

Run with sudo against an already built app. The extracted public payload is
read and --verify-bundle is run after dropping all root/group privileges.
Outer signature checks belong to the separate signed-payload CI step.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import runpy
import shutil
import subprocess
import tarfile
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    if os.getuid() != 0:
        parser.error("root is required for the disposable root-owned archive fixture")
    source = args.app.resolve(strict=True)
    if source == Path("/Applications/Rieul.app") or source.name != "Rieul.app":
        parser.error("use a build fixture, never the installed app")
    builder = runpy.run_path(str(Path(__file__).with_name("update-artifact.py")))
    nobody = pwd.getpwnam("nobody")
    assert nobody.pw_uid != 0 and nobody.pw_gid != 0
    with tempfile.TemporaryDirectory(prefix="rieul-public-archive-", dir="/private/tmp") as temporary:
        base = Path(temporary)
        base.chmod(0o755)  # Only this owned fixture's traversal boundary.
        app = base / "build" / "Rieul.app"
        app.parent.mkdir(mode=0o755)
        shutil.copytree(source, app, symlinks=True)
        if not (app / "Contents/Resources/rieul-update.json").exists():
            builder["manifest"](app)
        archive = base / "rieul-macos-update.tar"
        builder["archive"](app, archive)
        extracted = base / "extracted"
        extracted.mkdir(mode=0o755)
        extracted.chmod(0o755)
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            assert all(member.uid == 0 and member.gid == 0 for member in members)
            # Archive is generated above from our own build copy; never accepts
            # an arbitrary user archive. Preserve its modes and root ownership.
            tar.extractall(extracted, members=members)
        payload = extracted / "Rieul.app"
        assert all(path.lstat().st_uid == 0 for path in payload.rglob("*"))
        reader = r'''
import os, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
assert os.getuid() != 0 and os.getgid() != 0 and not os.getgroups()
count = 0
for directory, dirs, files in os.walk(root, onerror=lambda error: (_ for _ in ()).throw(error)):
    for name in files:
        path = pathlib.Path(directory) / name
        assert path.resolve().is_relative_to(root.resolve())
        with path.open("rb") as stream:
            while stream.read(65536): pass
        count += 1
subprocess.run([str(root / "Contents/MacOS/rieul-gui"), "--verify-bundle"], check=True,
               env={"PATH": "/usr/bin:/bin", "HOME": str(root.parent)})
print("Non-admin read and native integrity check passed for", count, "root-owned files")
'''
        def drop_privileges():
            os.setgroups([])
            os.setgid(nobody.pw_gid)
            os.setuid(nobody.pw_uid)
        subprocess.run(["/usr/bin/python3", "-c", reader, str(payload)],
                       check=True, cwd=base, preexec_fn=drop_privileges,
                       env={"PATH": "/usr/bin:/bin", "HOME": str(base)})
        print(json.dumps({"root_owned_archive": True, "reader_uid": nobody.pw_uid,
                          "supplementary_groups": [], "native_verify_bundle": True}))


if __name__ == "__main__":
    main()
