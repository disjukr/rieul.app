# whats-going-on (wgo)

An AI-era remote shell/explorer prototype.

The product-level model is one daemon per machine. Internally each OS backend
can choose the process topology that fits that OS. The first backend is Windows
and uses a system service plus a per-user tray daemon.

## Layout

- `daemon/core`: shared Rust protocol, config, pairing, and service traits.
- `daemon/windows`: Windows-specific system/user daemon binaries.
- `protocol`: BDL schemas, RPC/wire standards, and protocol docs.
- `web`: Vite + React + TypeScript browser client, managed with Deno.

See `protocol/README.md` for protocol layer terminology. In short, `wgo-wire` is
the byte-level envelope family carried over WebTransport reqres streams and
datagrams, and `wgo-rpc` defines proc ids, stream shapes, payload schemas, and
method errors.

## Development

Run the currently implemented daemon pair:

```sh
deno task windows:dev:daemons
```

Stop any detached dev daemons:

```sh
deno task windows:kill:daemons
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

Enter the printed code in the web client's pairing field. The browser stores the
returned client id and client secret in `localStorage`.

Use a trusted certificate by adding a domain and certificate files to the daemon
config:

```yaml
domain: pc.example.com
tls:
  certFile: /etc/wgo/cert.pem
  keyFile: /etc/wgo/key.pem
```

If `domain` ends in `.ts.net` and `tls` is omitted, the daemon runs
`tailscale
cert --min-validity=168h` and loads the generated Let's Encrypt
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
