# Windows user terminal IPC design

## Outcome

Terminal child processes and shell discovery run in `rieul-windows-user.exe`,
under the interactive user's token and environment. The LocalSystem service
continues to expose the public terminal RPC API, but it never creates a PTY or
shell process locally.

This is both a correctness and a security boundary. The system service MUST NOT
fall back to a LocalSystem terminal when the user agent is missing, incompatible,
or disconnected.

## Ownership

The responsibilities are intentionally split at the raw PTY boundary.

| System daemon owns | User agent owns |
| --- | --- |
| Public terminal session id and metadata | Shell discovery in the user profile |
| Paired-client creator id | User environment and executable resolution |
| WebTransport attach ids and control ownership | ConPTY and child process handles |
| Output retention and public sequence numbers | Reading and writing raw PTY bytes |
| OSC title/CWD parsing and shell metadata | PTY resize and process termination |
| Mapping IPC failure to public close events | Cleanup when the IPC stream disappears |

Keeping public attach state in the system daemon means the public RPC contracts
do not need an IPC-specific attach model. One public terminal session has one
long-lived `HostAgentTerminal` bidi IPC stream.

## IPC procedures

The agent provides three new procedures in `schemas/ipc/agent.bdl`:

1. `GetAgentInfo` (`id 7`, unary) identifies the agent process lifetime, login
   session, profile, and supported IPC procedures.
2. `SnapshotAgentTerminalShells` (`id 8`, unary) discovers shells using the
   agent user's `PATH`, `LOCALAPPDATA`, Windows Terminal settings, and Git
   installation paths.
3. `HostAgentTerminal` (`id 9`, bidi) owns exactly one PTY for the lifetime of
   the stream.

`HostAgentTerminal` has this state machine:

```text
system                                      agent
  |                                           |
  | Start(cols, rows, cwd, launch) ---------->|
  |<----------------------------- Started(cwd)|
  |                                           |
  | Input(bytes) ---------------------------->|
  | Resize(cols, rows) ---------------------->|
  |<------------------------------- Output(*) |
  |                                           |
  |<-------------------------- Exited / Closed|
  |<------------------------ response stream EOF
```

`Start` MUST be the first request and MUST occur exactly once. The agent emits
no output event before `Started`. A startup failure is an `IpcProcError` and
ends the exchange. Once started, unexpected request variants or invalid values
fail the exchange and terminate the child.

Agent shell and launch payloads deliberately use IPC-specific structs instead
of importing the public terminal RPC models. The system maps between the
structurally equivalent types at the boundary; this keeps public proc
definitions out of the local IPC proc registry.

The system assigns `TerminalEvent.OutputChunk.seq` as it consumes ordered
`Output` events. This keeps replay buffering and sequence semantics unchanged
for public clients.

## Lifecycle mapping

- Public `CreateTerminalSession` selects the active user agent, opens
  `HostAgentTerminal`, sends `Start`, and waits for `Started` before returning.
- Public `SubscribeAvailableShells` periodically snapshots the selected agent.
  If there is no eligible agent, it publishes an empty table. It never reports
  shells discovered in the SYSTEM environment.
- Public `TakeTerminalControl` updates system-owned attach state and sends
  `Resize` only after local validation succeeds.
- Public `WriteTerminalInput` keeps its existing attach and primary-control
  checks. Accepted chunks become `Input` commands.
- Public `CloseTerminalSession` sends `Close`, waits briefly for `Closed`, then
  drops the IPC stream and removes the public session row.
- `Exited` becomes public `SessionExited`; the system retains the exited public
  session record until the client closes it.
- Agent loss, pipe failure, or protocol failure becomes public
  `SessionClosed(Failed(...))` and closes all attaches for that terminal.
- System shutdown drops every host stream. The agent MUST terminate the
  associated children when it observes request EOF or transport loss.

Terminal sessions therefore retain the current public guarantee: they may
survive browser and WebTransport reconnects, but not a system-daemon restart.

## User-session selection

Windows may have multiple logged-in sessions. Agent endpoints SHOULD include
both profile and login-session identity:

```text
\\.\pipe\rieul-agent-profile-<profileId>-session-<sessionId>
```

For the first implementation, the system selects the active interactive
session. If more than one session is active and policy cannot choose
deterministically, terminal creation fails instead of choosing an account
silently. Existing terminal streams remain bound to the agent that created
them even if the active session changes. Available-shell snapshots switch to
the newly selected agent.

The MSI MUST launch the user agent unelevated at the end of installation as
well as register it for future logons. Otherwise the agent is absent until the
next login.

## Security requirements

- The agent pipe DACL permits only LocalSystem and the owning login user.
- The system verifies the named-pipe server process id, process token SID, and
  token session id before trusting the endpoint. Self-reported `AgentInfo`
  fields are not authentication evidence.
- The agent verifies that the pipe client is LocalSystem.
- Pipe names are profile- and login-session-scoped and use first-instance
  creation to reduce endpoint squatting risk.
- The system validates dimensions, command sizes, and input chunk sizes before
  forwarding. The agent validates them again before acting.
- PTY output chunks are bounded. Socket backpressure is allowed to pause PTY
  reads; implementations MUST NOT accumulate unbounded output in the agent.
- Missing agents, unsupported procedure versions, and all IPC failures fail
  closed. There is no direct SYSTEM PTY fallback.

## Implementation sequence

1. Add generated IPC types and codec tests for ids 7 through 9.
2. Generalize the current one-request agent named-pipe server to multiplex
   socket-wire streams for unary and bidi procedures.
3. Move Windows shell discovery and PTY hosting into the user executable.
4. Add a remote PTY backend to the host terminal manager while retaining its
   public session, attach, replay, and metadata logic.
5. Add active-session routing and named-pipe peer-token validation.
6. Start the user agent unelevated during MSI completion.
7. Add integration tests proving `whoami` matches the interactive user, a
   per-user Git Bash is discoverable, agent loss kills the child, and no SYSTEM
   shell is created when the agent is unavailable.
