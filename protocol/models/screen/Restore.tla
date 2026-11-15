------------------------------ MODULE Restore ------------------------------
EXTENDS Naturals
CONSTANT SafeRestore
VARIABLES installed, desired, revision, pendingRevision, gate, phase
vars == <<installed, desired, revision, pendingRevision, gate, phase>>
Init == /\ installed = "K" /\ desired = "K" /\ revision = 0
        /\ pendingRevision = 0 /\ gate = TRUE /\ phase = "initial"
BeginA == /\ phase = "initial"
          /\ desired' = "A" /\ revision' = revision + 1
          /\ pendingRevision' = revision + 1 /\ gate' = FALSE
          /\ phase' = "pendingA" /\ UNCHANGED installed
RestoreK == /\ phase = "pendingA"
            /\ desired' = "K"
            /\ revision' = IF SafeRestore THEN revision + 1 ELSE revision
            /\ gate' = TRUE /\ phase' = "restoredK"
            /\ UNCHANGED <<installed, pendingRevision>>
ReplyA == /\ phase = "restoredK"
          /\ installed' = IF pendingRevision = revision THEN "A" ELSE installed
          /\ gate' = TRUE /\ phase' = "finished"
          /\ UNCHANGED <<desired, revision, pendingRevision>>
Next == BeginA \/ RestoreK \/ ReplyA
Spec == Init /\ [][Next]_vars
OpenGateMatchesDesired == gate => installed = desired
=============================================================================
