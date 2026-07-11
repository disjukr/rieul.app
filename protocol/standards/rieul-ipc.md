# rieul IPC

This document defines local IPC policy for rieul system, GUI, and user-agent
processes. It builds on `rieul-socket-wire` for framing and on `rieul-rpc` for
business-level proc contracts.

Normative terms such as MUST, MUST NOT, SHOULD, and MAY are used as defined in
RFC 2119.

## Process Roles

rieul uses these local process roles:

- `system`: long-running host daemon. On Windows this may run as a Windows
  service; on macOS this may run as a privileged or launchd-managed daemon.
- `gui`: user-session process that owns tray/menu-bar UI, notifications,
  pairing prompts, and settings/info windows.
- `agent`: user-session process that exposes desktop-session data to the system
  daemon. A platform MAY merge this role into the GUI process.
- `launcher`: short-lived process that attempts to activate an already-running
  GUI process.

The system daemon MUST NOT assume it can directly display desktop UI. It SHOULD
send UI requests to a GUI process through local IPC.

## Profile Identity

`instanceId` is the daemon process lifetime id exposed by `GetDaemonInfo`. It
changes when the daemon process restarts.

`profileId` identifies a stable local daemon slot such as production, dev, or a
specific config path. Local IPC endpoints, GUI single-instance locks, and user
agents SHOULD be scoped by `profileId`.

If the user does not pass an explicit profile, implementations SHOULD derive
`profileId` from the canonical daemon config path:

```text
profileId = short_hash(canonical_config_path)
```

Implementations that expose a command-line option SHOULD call it `--profile`.
Profile ids used in OS endpoint names MUST be sanitized to a conservative ASCII
subset, or replaced by a deterministic hash.

## Endpoint Naming

Preferred Windows names:

```text
\\.\pipe\rieul-gui-profile-<profileId>
\\.\pipe\rieul-agent-profile-<profileId>-session-<sessionId>
```

User-agent endpoints SHOULD include the OS login-session identity when a host
can have multiple interactive sessions. A system daemon MUST verify the peer
process token and session identity before routing privileged requests to an
agent; self-reported IPC identity fields are diagnostic metadata only.

Preferred macOS names:

```text
/tmp/rieul-gui-profile-<profileId>-<uid>.sock
/tmp/rieul-agent-profile-<profileId>-<uid>.sock
```

## Socket Wire Binding

rieul IPC uses `rieul-socket-wire` over OS-local byte-stream transports such as
named pipes and Unix domain sockets.

The profile is bound by endpoint selection rather than by socket-wire message
fields. A process that connects to `...profile-<profileId>` is requesting that
profile's IPC service.

An IPC endpoint selects the `rieul.ipc` proc registry for all socket-wire
messages on that connection. A system daemon that intentionally exposes public
daemon RPC over local IPC SHOULD use a separate endpoint for the `rieul.rpc`
registry.

## IPC RPC Service

Local GUI/agent operations are modeled as `rieul-ipc` procs in the IPC registry
selected by the endpoint.

IPC proc schema files SHOULD be grouped by provider role. For example,
`schemas/ipc/gui.bdl` contains procs whose `@ server` role is `gui`, and
`schemas/ipc/agent.bdl` contains procs whose `@ server` role is `agent`.

IPC proc schemas use the `rieul-ipc` BDL standard. It reuses `rieul-rpc` proc
semantics and adds required proc direction attributes:

- `@ server`: the IPC process role that provides the proc on an endpoint.
- `@ client`: the IPC process role, or comma-separated role list, allowed to
  call the proc.

For example, a proc marked `@ server - gui` and `@ client - system` is provided
by the GUI process and called by the system daemon.

Example IPC procs:

- `ShowPairingCode`
- `ConfirmPairing`
- `ShowDaemonInfo`
- `ActivateGui`
- `PairingCompleted`
- `SnapshotWindows`
- `GetAgentInfo`
- `SnapshotAgentTerminalShells`
- `HostAgentTerminal`

These procs are implementation plumbing. They are not public client RPC methods
unless a future public API explicitly promotes them.

## Single Instance

The GUI SHOULD enforce one GUI process per `profileId` and OS user session. A
second launch for the same profile SHOULD connect to the existing GUI, invoke an
IPC `ActivateGui` proc, then exit.

The single-instance lock MUST be scoped by `profileId`. It MUST NOT use
`instanceId`, because `instanceId` changes on daemon restart and describes the
daemon process, not the GUI slot.

## Security

Local IPC endpoints SHOULD be accessible only to the expected local user and,
where needed, the privileged daemon account. Implementations SHOULD use OS
permissions or endpoint ACLs rather than application-level secrets when the OS
provides a reliable mechanism.

IPC messages MUST NOT carry long-lived credential secrets. Pairing IPC may
carry short-lived display codes and confirmation codes.

Privileged daemons MUST NOT execute user-context operations in the privileged
process as a fallback when an expected agent is unavailable. In particular, a
terminal requested through a user agent MUST fail closed rather than launch as
root or LocalSystem.

Receivers MUST validate socket-wire messages, endpoint profile, proc id,
payload schema, numeric fields, and size limits before acting on requests.
