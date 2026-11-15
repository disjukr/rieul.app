------------------------------ MODULE Screen ------------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Fenced, SafeRelease, MaxSteps
P == {"A", "B"}
M == {"m1", "m2"} \* One machine; each monitor is a separate session key.
None == "none"
NoTag == [monitor |-> None, gen |-> 0, ep |-> 0]
VARIABLES selected, epoch, generation, live, plugged, pending, shown,
          owner, hostControl, releasing, steps
vars == <<selected, epoch, generation, live, plugged, pending, shown,
          owner, hostControl, releasing, steps>>
Viewers(m, s) == {p \in P : s[p] = m}
Tag(p) == [monitor |-> selected[p], gen |-> generation[selected[p]], ep |-> epoch[p]]
Init == /\ selected = [p \in P |-> None]
        /\ epoch = [p \in P |-> 0]
        /\ generation = [m \in M |-> 0]
        /\ live = {}
        /\ plugged = M
        /\ pending = [p \in P |-> NoTag]
        /\ shown = [p \in P |-> NoTag]
        /\ owner = [m \in M |-> None]
        /\ hostControl = {}
        /\ releasing = {}
        /\ steps = 0
Select(p, m) ==
    /\ selected[p] # m /\ m \in plugged
    /\ epoch[p] < 2 /\ generation[m] < 2
    /\ LET s == [selected EXCEPT ![p] = m]
           old == selected[p]
       IN /\ selected' = s
          /\ live' = {d \in M : Viewers(d, s) # {}}
          /\ generation' = [d \in M |-> IF d = m /\ d \notin live THEN generation[d] + 1 ELSE generation[d]]
          /\ owner' = [d \in M |-> IF owner[d] = p THEN None ELSE owner[d]]
          /\ releasing' = (releasing \cup {d \in M : owner[d] = p}) \cap live'
          /\ hostControl' = hostControl \cap live'
    /\ epoch' = [epoch EXCEPT ![p] = @ + 1]
    /\ shown' = [shown EXCEPT ![p] = NoTag]
    /\ UNCHANGED <<plugged, pending>>
Leave(p) ==
    /\ selected[p] # None /\ epoch[p] < 2
    /\ LET s == [selected EXCEPT ![p] = None]
       IN /\ selected' = s
          /\ live' = {d \in M : Viewers(d, s) # {}}
          /\ owner' = [d \in M |-> IF owner[d] = p THEN None ELSE owner[d]]
          /\ releasing' = (releasing \cup {d \in M : owner[d] = p}) \cap live'
          /\ hostControl' = hostControl \cap live'
    /\ epoch' = [epoch EXCEPT ![p] = @ + 1]
    /\ shown' = [shown EXCEPT ![p] = NoTag]
    /\ UNCHANGED <<plugged, pending, generation>>
Configure(p) ==
    /\ selected[p] \in live /\ pending[p] = NoTag
    /\ pending' = [pending EXCEPT ![p] = Tag(p)]
    /\ UNCHANGED <<selected, epoch, generation, live, plugged, shown, owner, hostControl, releasing>>
Reply(p) ==
    /\ pending[p] # NoTag
    /\ LET r == pending[p]
           valid == selected[p] = r.monitor /\ r.monitor \in live /\ r.monitor \in plugged
                    /\ epoch[p] = r.ep /\ generation[r.monitor] = r.gen
       IN shown' = [shown EXCEPT ![p] = IF ~Fenced \/ valid THEN r ELSE @]
    /\ pending' = [pending EXCEPT ![p] = NoTag]
    /\ UNCHANGED <<selected, epoch, generation, live, plugged, owner, hostControl, releasing>>
Unplug(m) ==
    /\ m \in plugged
    /\ \A p \in Viewers(m, selected) : epoch[p] < 2
    /\ selected' = [p \in P |-> IF selected[p] = m THEN None ELSE selected[p]]
    /\ epoch' = [p \in P |-> IF selected[p] = m THEN epoch[p] + 1 ELSE epoch[p]]
    /\ shown' = [p \in P |-> IF selected[p] = m THEN NoTag ELSE shown[p]]
    /\ live' = live \ {m} /\ plugged' = plugged \ {m}
    /\ owner' = [owner EXCEPT ![m] = None]
    /\ hostControl' = hostControl \ {m} /\ releasing' = releasing \ {m}
    /\ UNCHANGED <<generation, pending>>
Replug(m) == /\ m \notin plugged /\ plugged' = plugged \cup {m}
             /\ UNCHANGED <<selected, epoch, generation, live, pending, shown, owner, hostControl, releasing>>
Claim(p) ==
    /\ selected[p] \in live
    /\ LET m == selected[p]
       IN /\ owner[m] = None /\ m \notin releasing
          /\ owner' = [owner EXCEPT ![m] = p]
          /\ hostControl' = hostControl \cup {m}
    /\ UNCHANGED <<selected, epoch, generation, live, plugged, pending, shown, releasing>>
Release(m) ==
    /\ owner[m] # None
    /\ owner' = [owner EXCEPT ![m] = None]
    /\ releasing' = releasing \cup {m}
    /\ UNCHANGED <<selected, epoch, generation, live, plugged, pending, shown, hostControl>>
ResolveRelease(m, success) ==
    /\ m \in releasing
    /\ (success \/ ~SafeRelease \/ generation[m] < 2)
    /\ releasing' = releasing \ {m}
    /\ hostControl' = IF success \/ SafeRelease THEN hostControl \ {m} ELSE hostControl
    /\ generation' = IF ~success /\ SafeRelease THEN [generation EXCEPT ![m] = @ + 1] ELSE generation
    /\ shown' = [p \in P |-> IF ~success /\ SafeRelease /\ selected[p] = m THEN NoTag ELSE shown[p]]
    /\ UNCHANGED <<selected, epoch, live, plugged, pending, owner>>
Next == /\ steps < MaxSteps
        /\ (\/ \E p \in P, m \in M : Select(p,m)
            \/ \E p \in P : Leave(p) \/ Configure(p) \/ Reply(p) \/ Claim(p)
            \/ \E m \in M : Unplug(m) \/ Replug(m) \/ Release(m)
            \/ \E m \in M, ok \in BOOLEAN : ResolveRelease(m,ok))
        /\ steps' = steps + 1
Spec == Init /\ [][Next]_vars
SharedLifetime == \A m \in M : (m \in live) <=> (Viewers(m,selected) # {})
FreshDisplay == \A p \in P : shown[p] # NoTag =>
    /\ selected[p] = shown[p].monitor /\ selected[p] \in plugged \cap live
    /\ epoch[p] = shown[p].ep /\ generation[selected[p]] = shown[p].gen
ControlAccounted == \A m \in hostControl : owner[m] # None \/ m \in releasing
ValidOwner == \A m \in M : owner[m] # None => selected[owner[m]] = m /\ m \in live
NoImplicitTakeover == [][\A m \in M : owner[m] # None /\ owner'[m] # None => owner'[m] = owner[m]]_vars
=============================================================================
