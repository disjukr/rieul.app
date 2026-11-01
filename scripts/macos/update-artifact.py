#!/usr/bin/env python3
"""Build contract for #45. Run manifest BEFORE outer app signing/notarization,
then archive AFTER signing/stapling. This never signs, installs or publishes.
The daemon verifier independently distrusts and validates the resulting archive.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import tarfile


def entries(app):
    yield app
    for root, dirs, files in os.walk(app, followlinks=False):
        for name in sorted(dirs + files):
            yield Path(root) / name


def check_macho(path, required=False):
    with path.open("rb") as file:
        prefix = file.read(8)
    magics = {bytes.fromhex(value) for value in (
        "cefaedfe", "feedface", "cffaedfe", "feedfacf",
        "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
    )}
    if prefix[:4] not in magics and not required:
        return
    if prefix != bytes.fromhex("cffaedfe0c000001"):
        raise ValueError(f"unsupported Mach-O architecture (arm64 only): {path}")


def inspect(app):
    if app.name != "Rieul.app" or app.is_symlink() or not app.is_dir():
        raise ValueError("expected a real Rieul.app build directory")
    root = app.resolve()
    for path in entries(app):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            if os.path.isabs(os.readlink(path)) or not path.resolve(strict=True).is_relative_to(root):
                raise ValueError(f"escaping or dangling link: {path}")
        elif not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError(f"special file: {path}")
        elif info.st_mode & 0o7022:
            raise ValueError(f"unsafe permissions: {path}")
        elif stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise ValueError(f"hardlinked file: {path}")
        elif stat.S_ISREG(info.st_mode):
            check_macho(path)
    for name in ("Library/LaunchServices/rieul-macos-system", "MacOS/rieul-macos-launcher", "MacOS/rieul-gui"):
        path = app / "Contents" / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"missing regular arm64 entry point: {path}")
        check_macho(path, required=True)


def manifest(app):
    inspect(app)
    with (app / "Contents/Info.plist").open("rb") as file:
        info = plistlib.load(file)
    version = info["CFBundleShortVersionString"]
    if info["CFBundleIdentifier"] != "app.rieul" or not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("wrong bundle identity or non-stable version")
    daemon = app / "Contents/Library/LaunchServices/rieul-macos-system"
    if daemon.is_symlink() or not daemon.is_file():
        raise ValueError("daemon must be a regular file")
    hasher = hashlib.sha256()
    with daemon.open("rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    destination = app / "Contents/Resources/rieul-update.json"
    # Exclusive creation prevents accidentally rewriting a signed contract.
    with destination.open("x") as file:
        json.dump({"schema": 1, "version": version, "updater_protocol": 1,
                   "database_schema": 2, "daemon_sha256": digest}, file, sort_keys=True)
        file.write("\n")
    destination.chmod(0o644)


def archive(app, output):
    inspect(app)
    if output.resolve().is_relative_to(app.resolve()):
        raise ValueError("archive output must be outside the app")
    if not (app / "Contents/Resources/rieul-update.json").is_file():
        raise ValueError("missing update manifest; generate it before signing")
    # GNU long-name records are interpreted by tar::Entry::path(). No PAX
    # xattrs/ACLs, compression, hardlinks, ownership or special mode metadata.
    with output.open("xb") as file, tarfile.open(fileobj=file, mode="w", format=tarfile.GNU_FORMAT) as tar:
        for path in entries(app):
            name = "Rieul.app" if path == app else "Rieul.app/" + path.relative_to(app).as_posix()
            info = tar.gettarinfo(str(path), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            if info.isfile():
                with path.open("rb") as source:
                    tar.addfile(info, source)
            else:
                tar.addfile(info)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["manifest", "archive"])
    parser.add_argument("app", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.app.resolve() == Path("/Applications/Rieul.app"):
        parser.error("operate on a build copy, never the installed app")
    if args.operation == "manifest":
        manifest(args.app)
    elif args.output is None or args.output.name != "rieul-macos-update.tar":
        parser.error("archive requires --output .../rieul-macos-update.tar")
    else:
        archive(args.app, args.output)


if __name__ == "__main__":
    main()
