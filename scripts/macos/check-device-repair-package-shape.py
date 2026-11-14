#!/usr/bin/env python3
"""Read only after a native pkgutil expansion; never installs a package."""
from pathlib import Path
import sys
from xml.etree import ElementTree

root = Path(sys.argv[1])
info = ElementTree.parse(root / "PackageInfo").getroot()
expected_scripts = {"postinstall", "rieul-repair-bootstrap"}
payloads = info.findall("payload")
scripts = info.findall("scripts")
if not (
    info.tag == "pkg-info"
    and info.get("identifier") == "app.rieul.updater-device-repair"
    and info.get("version") == "1.0.0"
    and all(p.get("numberOfFiles") == "0" for p in payloads)
    and not (root / "Payload").exists()
    and len(scripts) == 1
    and len(scripts[0]) == 1
    and scripts[0][0].tag == "postinstall"
    and scripts[0][0].get("file") in ("./postinstall", "postinstall")
    and {p.name for p in (root / "Scripts").iterdir()} == expected_scripts
    and all(p.is_file() and not p.is_symlink() for p in (root / "Scripts").iterdir())
):
    raise SystemExit("unexpected package identity, scripts or payload")
