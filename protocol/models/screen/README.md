# Screen concurrency models

Small executable TLA+ safety models for shared Screen viewers and asynchronous
configuration. These are design checks, not a proof of the implementation or
an explanation of a particular reconnect incident. No running daemon is needed.

## Run with official TLC

Requires Java 21, curl, and either `sha256sum` or macOS `shasum -a 256`.
From this directory, download the official TLA+ tools into temporary storage:

```sh
tools=$(mktemp -d)
curl -fL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  -o "$tools/tla2tools.jar"
# Verify this SHA-256 before running the jar.
sha256sum "$tools/tla2tools.jar" # macOS: shasum -a 256 "$tools/tla2tools.jar"
# 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

java -XX:+UseParallelGC -Xmx1g -cp "$tools/tla2tools.jar" tlc2.TLC \
  -workers 1 -metadir "$tools/fixed" -config fixed Screen
java -XX:+UseParallelGC -Xmx1g -cp "$tools/tla2tools.jar" tlc2.TLC \
  -workers 1 -metadir "$tools/restore-fixed" -config restore-fixed Restore
```

The release asset reports TLC 2.19, revision `5a47802`. No global installation
is required. To inspect counterexamples, run the same command with
`-config old-fence Screen`, `-config old-release Screen`, or
`-config restore-old Restore`, using a different temporary `-metadir` each time.
The three negative configurations are deliberately unsafe and should exit 12.

Checked with Java 21 and this exact jar:

| Configuration   | Exit | Generated / distinct states | Depth | Result                            |
| --------------- | ---- | --------------------------- | ----- | --------------------------------- |
| `fixed`         | 0    | 42,881 / 13,177             | 9     | No error within bounds            |
| `old-fence`     | 12   | 417 / 272                   | 5     | `FreshDisplay` violated           |
| `old-release`   | 12   | 467 / 294                   | 5     | `ControlAccounted` violated       |
| `restore-fixed` | 0    | 4 / 4                       | 4     | No error in isolated scenario     |
| `restore-old`   | 12   | 4 / 4                       | 4     | `OpenGateMatchesDesired` violated |

Corrected searches completed with empty queues. Counterexample searches stop
at the first violation. Counts for negative searches can depend on exploration
order; the invariant failure is the regression signal. Depth includes the
initial state. Corrected Screen exploration covers at most eight transitions;
negative Screen configurations permit six.

## `Screen.tla`

Two panes share one implicit machine and two monitor IDs. `live` is a set of
canonical machine+monitor session slots. The first viewer starts a slot; the
last viewer stops it. `SharedLifetime` requires a slot exactly while it has
viewers, so leaving one pane preserves a remaining view. At-most-one session per
display is structural here, not independently proved for the actual registry.

Configure requests and replies are separate transitions. Each pane has one
outstanding response tagged with monitor, attachment generation, and selection
epoch. A reply can outlive close, reselect, unplug, or reconnect. Corrected
acceptance checks all three tags. The old-fence trace selects m1, requests its
configuration, selects m2, then incorrectly displays the late m1 response.

Optional input ownership is per display. Explicit claim requires an unowned
slot with no pending release. No automatic acquisition or takeover is modeled.
Release removes local input authority immediately while remote release remains
accounted as pending. The old-release trace claims control, releases locally,
then rejects remote release while discarding its pending bookkeeping. Host
control remains without an owner or pending release.

Corrected release failure abstracts detach plus view-only reconnect as one
atomic step. It clears host authority, rotates generation, invalidates displayed
configuration, and preserves surviving selections. This **assumes detach revokes
old host authority**. It does not prove host detach/lease behavior, overlap during
reconnect, failed detach, authentication handling, or retry timing. There is no
fairness or guarantee that pending release eventually finishes.

Epochs and generations are bounded to 0..2. Selection, leave, and unplug are
atomic. The model omits wire framing, sockets, the machine mux, real timing,
decoder behavior, and two configure/quality requests in an unchanged selection.

## `Restore.tla`

This separate three-transition scenario keeps the larger state space small.
Receiver K is initially committed. Configure A begins. The application requests
K again. Old deduplication compares only committed K and opens the gate without
superseding pending A. Late A then installs while desired remains K.

The corrected model supersedes outstanding work before committed-key dedup can
return, and checks the captured revision before late installation. An equivalent
implementation may dedup only when no configure is pending. A revision check on
the outer gate alone does not prove that the inner receiver rejected stale work.

## Intended implementation mapping

- [`web/src/state/desktop.ts`](../../../web/src/state/desktop.ts) owns shared
  session selection, attachment generation, selection/configuration/quality
  revisions, viewer registration, input ownership, and pending owner release.
  The model collapses additional configuration revision and layout checks into
  its epoch. It therefore does not establish same-selection request ordering.
- [`web/src/protocol/desktop-video.ts`](../../../web/src/protocol/desktop-video.ts)
  owns receiver configuration, committed-key dedup, and pending configurations.
  [`desktop-video-gate.ts`](../../../web/src/protocol/desktop-video-gate.ts)
  owns gate revision checks. `Restore.tla` abstracts their coordinated behavior,
  not the decoder internals.
- [`web/tests/desktop-video-gate.test.ts`](../../../web/tests/desktop-video-gate.test.ts)
  exercises receiver and gate races against implementation code. Model checking
  supplements these tests; it does not replace them.

The unsafe variants demonstrate that the guards matter in these abstractions.
Passing a bounded model does not by itself establish that production code
implements every modeled transition or that an unbounded protocol is correct.
