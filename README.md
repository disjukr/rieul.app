# rieul.app

<p align="center">
  <img src="./rieul.svg" alt="Rieul logo" width="96" height="96">
</p>

<p align="center">
  <a href="https://rieul.app">rieul.app</a>
</p>

---

Rieul is a remote workspace for the machines you own.

Install the Rieul daemon on a device, connect to it from a client, and work with
that machine through a structured remote interface from wherever you are.

https://github.com/user-attachments/assets/50d072d2-a718-41a3-961f-1ca05987a029

## Install

Before installing Rieul:

1. [Install Tailscale](https://tailscale.com/docs/install) and connect the
   device to your tailnet.
2. [Set up the Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli)
   so the `tailscale` command is available from your terminal.
3. In the Tailscale admin console, make sure both
   [MagicDNS](https://tailscale.com/docs/features/magicdns) and
   [HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)
   are enabled for your tailnet.

On macOS:

```sh
curl -fsSL https://rieul.app/install.sh | sh
```

On Windows, run PowerShell:

```powershell
irm https://rieul.app/install.ps1 | iex
```

## What Rieul Does

Rieul is built around two parts:

- A daemon that runs on each device you want to control.
- A client that connects to those daemons and gives you tools for working with
  the remote machine.

The goal is to make remote machine operation more direct and inspectable:

- Browse files and directories.
- View text files, images, and other supported content.
- Open terminal sessions that survive client refreshes and can be detached like
  tmux sessions.
- Inspect running processes, view their open file handles and sockets, and kill
  processes when needed.
- Expose more system-level tools through the same client surface over time.

## Roadmap

- [x] MVP.
- [ ] Remote desktop control.
- [ ] LLM agent workflows for operating connected machines.
- [ ] File sharing between machines.

## Project Status

Rieul is under active development. Until the 1.0 release, backward compatibility
is not guaranteed.

The project currently focuses on desktop environments. Windows and macOS
packages install the system daemon plus a per-user desktop helper. A web client
with mobile support is also available for connecting to paired daemons from the
browser.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development, packaging, and release
documentation.

## License

Licensed under either of Apache License, Version 2.0 or MIT license at your
option.
