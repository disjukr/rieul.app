--------------------------- MODULE InputCleanup ---------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS ExactInputCleanup, MaxSteps
Ids == 1..2
None == 0
VARIABLES current, nextId, pending, closed, queued, last, steps
vars == <<current, nextId, pending, closed, queued, last, steps>>
Observe(kind, target) == [kind |-> kind, target |-> target,
    beforeCurrent |-> current, beforeClosed |-> closed,
    beforeQueued |-> queued, beforePending |-> pending]
Init ==
    /\ current = None /\ nextId = 1 /\ pending = {} /\ closed = {}
    /\ queued = {} /\ steps = 0 /\ last = Observe("init", None)
\* queueTerminalInput allocates an object; sendTerminalInput can remain pending.
Start ==
    /\ current = None /\ nextId \in Ids
    /\ current' = nextId /\ pending' = pending \cup {nextId}
    /\ nextId' = nextId + 1 /\ last' = Observe("start", nextId)
    /\ UNCHANGED <<closed, queued>>
Enqueue ==
    /\ current # None /\ current \notin closed
    /\ queued' = queued \cup {current}
    /\ last' = Observe("enqueue", current)
    /\ UNCHANGED <<current, nextId, pending, closed>>
\* stopTerminalInput synchronously closes/discards this queue and clears ref.
Stop ==
    /\ current # None
    /\ closed' = closed \cup {current} /\ queued' = queued \ {current}
    /\ current' = None /\ last' = Observe("stop", current)
    /\ UNCHANGED <<nextId, pending>>
\* A previous async call's finally must close its own object, but not clear a
\* new call's ref. Completion order is independent of allocation order.
Finish(s) ==
    /\ s \in pending
    /\ pending' = pending \ {s} /\ closed' = closed \cup {s}
    /\ queued' = queued \ {s}
    /\ current' = IF ~ExactInputCleanup \/ current = s THEN None ELSE current
    /\ last' = Observe("finish", s)
    /\ UNCHANGED nextId
Next ==
    /\ steps < MaxSteps
    /\ (Start \/ Enqueue \/ Stop \/ \E s \in Ids : Finish(s))
    /\ steps' = steps + 1
Spec == Init /\ [][Next]_vars
TypeOK ==
    /\ current \in Ids \cup {None} /\ nextId \in 1..3
    /\ pending \subseteq Ids /\ closed \subseteq Ids /\ queued \subseteq Ids
LiveQueue == current # None => current \in pending \ closed
NoClosedInput == queued \cap closed = {}
FinishIsolation == last.kind = "finish" =>
    /\ current = IF last.beforeCurrent = last.target THEN None ELSE last.beforeCurrent
    /\ closed = last.beforeClosed \cup {last.target}
    /\ queued = last.beforeQueued \ {last.target}
    /\ pending = last.beforePending \ {last.target}
=============================================================================
