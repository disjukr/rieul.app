----------------------------- MODULE Terminal -----------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS ExactCleanup, VacancyOnly, EpochFence,
          MaxAttachments, MaxEpoch, MaxSteps
Ids == 1..MaxAttachments
Rpc == {"rpc1", "rpc2"}
None == 0
Sizes == {"small", "large"}
VARIABLES live, owners, nextId, primary, epoch, size, exited, leases,
          last, steps
vars == <<live, owners, nextId, primary, epoch, size, exited, leases,
          last, steps>>

\* An observation of a completed operation, not an authorization oracle.
\* The invariants below always use the full contract, independent of mutations.
Observation(kind, a, r, token, accepted, requested, resizeOK) ==
    [kind |-> kind, target |-> a, rpc |-> r, token |-> token,
     accepted |-> accepted, requested |-> requested, resizeOK |-> resizeOK,
     beforeLive |-> live, beforePrimary |-> primary, beforeEpoch |-> epoch,
     beforeSize |-> size, beforeExit |-> exited]
Init ==
    /\ live = {} /\ owners = [a \in Ids |-> "unallocated"]
    /\ nextId = 1 /\ primary = None /\ epoch = 0 /\ size = "small"
    /\ exited = FALSE /\ leases = {} /\ steps = 0
    /\ last = Observation("init", None, "rpc1", 0, FALSE, FALSE, FALSE)
LivePrimary == primary \in live

\* TerminalManager::attach holds one lock across registration, vacancy check,
\* fallible resize, authority update, and capturing AttachedTerminal.
Attach(r, requested, resizeOK, newSize) ==
    /\ nextId \in Ids
    /\ LET grant == requested /\ ~exited /\ (~LivePrimary \/ ~VacancyOnly)
                      /\ resizeOK
       IN /\ grant => epoch < MaxEpoch
          /\ live' = live \cup {nextId}
          /\ owners' = [owners EXCEPT ![nextId] = r]
          /\ primary' = IF grant THEN nextId ELSE primary
          /\ epoch' = IF grant THEN epoch + 1 ELSE epoch
          /\ size' = IF grant THEN newSize ELSE size
          /\ last' = Observation("attach", nextId, r, 0, grant, requested, resizeOK)
    /\ nextId' = nextId + 1
    /\ UNCHANGED <<exited, leases>>

\* Output stream finish/cancel/abort can run long after a replacement attach.
\* Detach deliberately leaves primary and epoch stale; vacancy uses membership.
Cleanup(a) ==
    /\ a < nextId
    /\ live' = IF ExactCleanup THEN live \ {a}
               ELSE {b \in live : owners[b] # owners[a]}
    /\ last' = Observation("cleanup", a, "rpc1", 0, FALSE, FALSE, FALSE)
    /\ UNCHANGED <<owners, nextId, primary, epoch, size, exited, leases>>

\* Explicit Take may preempt. Re-taking the same primary only resizes.
Take(a, r, resizeOK, newSize) ==
    /\ a < nextId
    /\ LET grant == a \in live /\ owners[a] = r /\ resizeOK
       IN /\ (grant /\ primary # a) => epoch < MaxEpoch
          /\ primary' = IF grant THEN a ELSE primary
          /\ epoch' = IF grant /\ primary # a THEN epoch + 1 ELSE epoch
          /\ size' = IF grant THEN newSize ELSE size
          /\ last' = Observation("take", a, r, 0, grant, TRUE, resizeOK)
    /\ UNCHANGED <<live, owners, nextId, exited, leases>>
BeginInput(a, r) ==
    /\ a < nextId
    /\ LET allowed == a \in live /\ owners[a] = r /\ primary = a
       IN /\ leases' = IF allowed THEN leases \cup {[attach |-> a, rpc |-> r, token |-> epoch]} ELSE leases
          /\ last' = Observation("begin", a, r, epoch, allowed, FALSE, FALSE)
    /\ UNCHANGED <<live, owners, nextId, primary, epoch, size, exited>>
WriteInput(lease) ==
    /\ lease \in leases
    /\ LET allowed == lease.attach \in live /\ owners[lease.attach] = lease.rpc
                       /\ primary = lease.attach
                       /\ (lease.token = epoch \/ ~EpochFence)
       IN last' = Observation("write", lease.attach, lease.rpc, lease.token, allowed, FALSE, FALSE)
    /\ UNCHANGED <<live, owners, nextId, primary, epoch, size, exited, leases>>
Exit ==
    /\ ~exited /\ exited' = TRUE
    /\ last' = Observation("exit", None, "rpc1", 0, FALSE, FALSE, FALSE)
    /\ UNCHANGED <<live, owners, nextId, primary, epoch, size, leases>>
Next ==
    /\ steps < MaxSteps
    /\ (\/ \E r \in Rpc, request \in BOOLEAN, ok \in BOOLEAN, s \in Sizes : Attach(r, request, ok, s)
        \/ \E a \in Ids : Cleanup(a)
        \/ \E a \in Ids, r \in Rpc, ok \in BOOLEAN, s \in Sizes : Take(a, r, ok, s)
        \/ \E a \in Ids, r \in Rpc : BeginInput(a, r)
        \/ \E lease \in leases : WriteInput(lease)
        \/ Exit)
    /\ steps' = steps + 1
Spec == Init /\ [][Next]_vars
TypeOK ==
    /\ live \subseteq Ids /\ owners \in [Ids -> Rpc \cup {"unallocated"}]
    /\ nextId \in 1..(MaxAttachments + 1) /\ primary \in Ids \cup {None}
    /\ epoch \in 0..MaxEpoch /\ size \in Sizes /\ exited \in BOOLEAN
    /\ leases \subseteq [attach : Ids, rpc : Rpc, token : 0..MaxEpoch]
AllocatedIdentity ==
    /\ live \subseteq 1..(nextId - 1)
    /\ primary # None => primary < nextId
    /\ \A a \in Ids : (owners[a] \in Rpc) <=> a < nextId
AttachRegistration == last.kind = "attach" =>
    /\ live = last.beforeLive \cup {last.target}
    /\ owners[last.target] = last.rpc
CleanupIsolation == last.kind = "cleanup" =>
    /\ live = last.beforeLive \ {last.target}
    /\ primary = last.beforePrimary /\ epoch = last.beforeEpoch
    /\ size = last.beforeSize
FastAttachNoSteal == last.kind = "attach" /\ last.beforePrimary \in last.beforeLive =>
    /\ primary = last.beforePrimary /\ epoch = last.beforeEpoch
    /\ size = last.beforeSize
FastAttachEligibility == last.kind = "attach" =>
    last.accepted <=> (last.requested /\ ~last.beforeExit
                      /\ last.beforePrimary \notin last.beforeLive /\ last.resizeOK)
FailureAtomicity == last.kind \in {"take", "attach"} /\ ~last.accepted =>
    /\ primary = last.beforePrimary /\ epoch = last.beforeEpoch
    /\ size = last.beforeSize
AuthorityEpoch == last.kind \in {"take", "attach"} /\ last.accepted =>
    /\ primary = last.target
    /\ epoch = last.beforeEpoch + (IF last.beforePrimary = last.target THEN 0 ELSE 1)
TakeOwner == last.kind = "take" /\ last.accepted =>
    /\ last.target \in last.beforeLive /\ owners[last.target] = last.rpc
InputAuthority == last.kind \in {"begin", "write"} /\ last.accepted =>
    /\ last.target \in live /\ owners[last.target] = last.rpc
    /\ primary = last.target /\ last.token = epoch
=============================================================================
