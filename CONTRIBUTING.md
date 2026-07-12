# Contributing

## Layout

- `daemon/core`: shared Rust protocol, config, pairing, and service traits.
- `daemon/host`: shared daemon runtime for WebTransport, RPC, auth, filesystem
  subscriptions, and TLS.
- `daemon/windows`: Windows-specific system/user daemon binaries.
- `daemon/macos`: macOS-specific system daemon and desktop installer bootstrap.
- `protocol`: BDL schemas, RPC/wire standards, and protocol docs.
- `web`: Vite + React + TypeScript browser client, managed with Deno.

See `protocol/README.md` for protocol layer terminology. In short, `rieul-wire`
is the byte-level envelope family carried over WebTransport reqres streams and
datagrams, and `rieul-rpc` defines proc ids, stream shapes, payload schemas, and
method errors.

## Development

Run the current Windows desktop development environment:

```sh
deno task windows:dev:desktop
```

Desktop development scripts run the daemon on `0.0.0.0:9019` by default so they
can run next to an installed desktop release using the product default port
`9012`.

If `tmp/dev/rieul.yaml` does not exist, the system daemon creates it. When
Tailscale is installed, the generated config uses `tailscale status --json` to
prefill `domain` from this machine's MagicDNS name. Otherwise, edit that file
and set `domain` to the Windows machine's Tailscale hostname, or add explicit
`tls` certificate paths. The daemon keeps running and enables transport once the
config is valid.

Run the macOS desktop development environment. The system daemon is launched
with `sudo`; the Deno Desktop daemon GUI runs as the current user.

```sh
deno task macos:dev:desktop
```

Use the same generated `tmp/dev/rieul.yaml` flow for macOS.

Stop any detached desktop development processes:

```sh
deno task windows:kill:desktop
```

```sh
deno task macos:kill:desktop
```

Check the daemon RPC endpoint:

```sh
cd web
deno task check:daemon
```

Create a short-lived pairing code for the dev daemon:

```sh
deno task windows:pair:dev
```

```sh
deno task macos:pair:dev
```

Enter the printed code in the web client's pairing field. The browser stores the
returned client id and client secret in `localStorage`.

Use a trusted certificate by adding a domain and certificate files to the daemon
config:

```yaml
domain: pc.example.com
tls:
  certFile: /etc/rieul/cert.pem
  keyFile: /etc/rieul/key.pem
```

If `domain` ends in `.ts.net` and `tls` is omitted, the daemon runs
`tailscale cert --min-validity=168h` and loads the generated Let's Encrypt
certificate from the config directory.

```yaml
domain: minipc.example-tailnet.ts.net
```

Certificate reloads are live for new WebTransport handshakes. Config and PEM
changes are detected with filesystem events. Managed `.ts.net` certificates also
run an hourly scheduled refresh.

Run the web client:

```sh
cd web
deno task dev
```

## GitHub Releases

Publishing a GitHub release runs the `Release desktop installers` workflow. It
builds the unsigned Windows MSI on a Windows runner and a Developer ID-signed,
notarized macOS PKG on a macOS runner, then attaches the installers and their
SHA-256 checksum files to the release. Installer versions come from release
tags in the `desktop-x.y.z` or `desktop-x.y.z-rc.n` format; for example,
`desktop-1.2.3` builds packages with version `1.2.3`, and
`desktop-1.2.3-rc.1` builds packages with version `1.2.3-rc.1`. Release assets
use stable names so the website install scripts can download them through
GitHub's `releases/latest` URL:

- `rieul-windows-desktop.msi`
- `rieul-windows-desktop.msi.sha256`
- `rieul-macos-desktop.pkg`
- `rieul-macos-desktop.pkg.sha256`

MSI `ProductVersion` still uses the
numeric `x.y.z` part because Windows Installer does not accept prerelease
suffixes there. The Windows release job accepts the WiX 7 EULA before building
the MSI.

The macOS release job imports the Developer ID Application and Installer
identities into an ephemeral keychain, signs the app and PKG, submits the PKG to
Apple's notary service, staples its ticket, and validates it before upload. It
reads these repository Actions secrets:

- `MACOS_APPLICATION_CERT_P12`
- `MACOS_APPLICATION_CERT_PASSWORD`
- `MACOS_INSTALLER_CERT_P12`
- `MACOS_INSTALLER_CERT_PASSWORD`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`
- `APPLE_API_PRIVATE_KEY`

The PKCS #12 files and App Store Connect API private key are stored as base64
strings. The signing keychain and decoded credentials are deleted at the end of
the job.

## Windows Desktop Packaging

Build an unsigned Windows desktop MSI package:

```sh
deno task windows:package:desktop
```

The default Windows packaging task uses WiX Toolset to write
`dist/windows/rieul-windows-desktop-<version>.msi`. Install the .NET SDK first;
the script restores the repo-local WiX CLI tool and required WiX extensions
automatically when `wix` is not already on `PATH`.

```sh
dotnet tool restore
deno task windows:package:desktop
```

Install the MSI from an elevated prompt, or double-click it and accept the UAC
prompt:

```sh
msiexec /i .\dist\windows\rieul-windows-desktop-0.1.0.msi
```

The MSI currently installs `rieul-windows-system.exe` and
`rieul-windows-user.exe` under `%ProgramFiles%\Rieul`, and installs the Deno
Desktop daemon GUI bundle under `%ProgramFiles%\Rieul\gui`. It registers
`rieul-windows-system` as an automatic LocalSystem service, starts the service
during install, launches the GUI app once when install finishes, creates a Start
Menu shortcut for the GUI, and adds an HKLM Run entry so the GUI starts on user
logon. The installer uses the standard WiX wizard UI, including a completion
dialog. Daemon data under `%ProgramData%\Rieul` is intentionally outside the
install directory and is not removed by uninstall.

The MSI is intentionally unsigned for now. Windows may still show an unknown
publisher or SmartScreen warning for downloaded installers, but MSI packaging
does not require trusting a development certificate before install.

Uninstall any earlier MSIX package before installing the MSI because both
packages own the same Windows service name.

Build the older development desktop MSIX package:

```sh
deno task windows:package:desktop:msix
```

The MSIX script stages `rieul-windows-system.exe`, `rieul-windows-user.exe`,
`rieul-windows-gui.exe`, generated app icons, and an `AppxManifest.xml`, then
invokes the Windows SDK `MakeAppx.exe` tool. By default it also creates a
development code-signing certificate and signs the package. The generated `.cer`
must be trusted on the test machine before the MSIX can be installed. The trust
task requests elevation when needed:

```sh
deno task windows:trust:desktop:dev-cert
```

```sh
Add-AppxPackage .\dist\windows\rieul-windows-desktop-0.1.0.msix
```

After installing, launch Rieul from the Start menu once if you want the GUI
immediately.

Passing `-SkipSign` writes `rieul-windows-desktop-0.1.0.unsigned.msix` so it
cannot accidentally replace the signed installable package.

The MSIX manifest declares `rieul-windows-system.exe` as a delayed-start
LocalSystem packaged service, `rieul-windows-user.exe` as the user-session data
agent, and `rieul-windows-gui.exe` as the interactive GUI. Uninstalling the
package removes the packaged service and app binaries. Daemon data under
`%ProgramData%\Rieul` is intentionally outside the package and is not removed by
MSIX uninstall.

For production signing, pass `-CertificatePath` and `-CertificatePassword` to
`scripts/windows/package-desktop-msix.ps1`.

## macOS Desktop Packaging

Build a macOS app bundle and DMG for the drag-to-install flow:

```sh
deno task macos:package:desktop
```

The DMG contains `Rieul.app` and an `/Applications` shortcut, laid out for the
usual drag-to-install flow. The app bundle contains the per-user Deno Desktop
GUI and installer controller.

Build a PKG for command-line installation, or for managed deployment after
signing it:

```sh
deno task macos:package:desktop:pkg
```

This writes `dist/macos/rieul-macos-desktop-<version>.pkg`. The package installs
the same `Rieul.app` under `/Applications` and then runs the app's bundled
install command to replace and start the system daemon and per-user GUI agent.
Install it without opening Installer.app:

```sh
sudo /usr/sbin/installer \
  -pkg dist/macos/rieul-macos-desktop-0.1.0.pkg \
  -target /
```

The PKG is unsigned by default. As with the unsigned DMG, macOS may require the
user to approve a downloaded package before installation.

On first launch from the DMG, the app prompts to install itself. Accepting the
prompt copies the app to `/Applications`, installs the privileged system daemon
under `/Library/Application Support/rieul/bin`, installs the LaunchDaemon and
LaunchAgent plists, and starts both jobs. macOS asks for an administrator
password because the system daemon runs through `/Library/LaunchDaemons`. The
GUI runs through a per-user LaunchAgent.

The app bundle also exposes Docker Desktop-style CLI entry points:

```sh
/Applications/Rieul.app/Contents/MacOS/install
/Applications/Rieul.app/Contents/MacOS/uninstall
```

The installed system config lives at:

```sh
/Library/Application Support/rieul/rieul.yaml
```

Logs are written under:

```sh
/Library/Logs/rieul
```

For Developer ID signing, pass a signing identity to the script:

```sh
scripts/macos/package-desktop-dmg.sh --sign "Developer ID Application: Example"
```

PKG distribution uses separate identities for the app bundle and installer
package:

```sh
scripts/macos/package-desktop-pkg.sh \
  --app-sign "Developer ID Application: Example" \
  --installer-sign "Developer ID Installer: Example"
```
