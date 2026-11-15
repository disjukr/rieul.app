------------------------------ MODULE Handoff ------------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANT PublishBeforeCommit

\* Two authenticated members, one handoff, two ordinary management operations.
\* A sequence is the abstract signed history: equality represents equality of
\* sequence, epoch AND hash, not merely matching sequence numbers.
Writes == {"w1", "w2"}
Handoff == "handoff"
Ops(log) == {log[i] : i \in 1..Len(log)}
Prefix(a, b) == /\ Len(a) <= Len(b)
                /\ a = SubSeq(b, 1, Len(a))
Transferred(log) == Handoff \in Ops(log)
Primary(log) == IF Transferred(log) THEN "B" ELSE "A"

VARIABLES source, target, sealed, prepared, sourceTx, targetTx,
          certificate, response, daylight
vars == <<source, target, sealed, prepared, sourceTx, targetTx,
          certificate, response, daylight>>
Init == /\ source = <<>> /\ target = <<>> /\ sealed = FALSE
        /\ prepared = [exists |-> FALSE, prefix |-> <<>>] /\ sourceTx = "idle" /\ targetTx = "idle"
        /\ certificate = <<>> /\ response = "none" /\ daylight = FALSE

\* Reconciliation never substitutes a shorter/different local prefix.
Reconcile == /\ ~Transferred(source) /\ targetTx = "idle"
             /\ Prefix(target, source) /\ target # source
             /\ target' = source
             /\ UNCHANGED <<source, sealed, prepared, sourceTx, targetTx,
                             certificate, response, daylight>>
Prepare == /\ ~prepared.exists /\ target = source
           /\ ~Transferred(target) /\ targetTx = "idle"
           /\ prepared' = [exists |-> TRUE, prefix |-> target]
           /\ UNCHANGED <<source, target, sealed, sourceTx, targetTx,
                           certificate, response, daylight>>

\* The writer and seal transactions share the source's serialization path.
SourceWrite(op) == /\ op \in Writes \ Ops(source)
                   /\ ~sealed /\ Primary(source) = "A" /\ sourceTx = "idle"
                   /\ source' = Append(source, op) /\ response' = "write"
                   /\ UNCHANGED <<target, sealed, prepared, sourceTx, targetTx,
                                   certificate, daylight>>
BeginSeal == /\ sourceTx = "idle" /\ ~sealed /\ Primary(source) = "A"
             /\ prepared.exists /\ prepared.prefix = source
             /\ sourceTx' = "seal"
             /\ UNCHANGED <<source, target, sealed, prepared, targetTx,
                             certificate, response, daylight>>
CommitSeal == /\ sourceTx = "seal"
              /\ source' = Append(source, Handoff) /\ sealed' = TRUE
              /\ sourceTx' = "idle"
              \* The signed result is exposed only after durable commit.
              /\ certificate' \in {Append(source, Handoff), <<>>}
              /\ response' = IF certificate' = <<>> THEN "none" ELSE "seal"
              /\ UNCHANGED <<target, prepared, targetTx, daylight>>
AbortSeal == /\ sourceTx = "seal" /\ sourceTx' = "idle"
             /\ UNCHANGED <<source, target, sealed, prepared, targetTx,
                             certificate, response, daylight>>

\* Deliberate negative mutation, not a production behavior: publish a signed
\* result while its source transaction can still roll back.
PublishStaged == /\ PublishBeforeCommit /\ sourceTx = "seal"
                 /\ certificate' = Append(source, Handoff)
                 /\ UNCHANGED <<source, target, sealed, prepared, sourceTx,
                                 targetTx, response, daylight>>

\* This is a new authenticated read/retry, not timeout-based source unsealing.
RecoverFromJournal == /\ sealed /\ certificate # source
                      /\ certificate' = source
                      /\ UNCHANGED <<source, target, sealed, prepared, sourceTx,
                                      targetTx, response, daylight>>
BeginActivation == /\ targetTx = "idle" /\ ~Transferred(target)
                   /\ Transferred(certificate)
                   /\ prepared.exists /\ prepared.prefix = SubSeq(certificate, 1, Len(certificate) - 1)
                   /\ Prefix(target, certificate)
                   /\ targetTx' = "activate"
                   /\ UNCHANGED <<source, target, sealed, prepared, sourceTx,
                                   certificate, response, daylight>>
CommitActivation == /\ targetTx = "activate"
                    /\ target' = Append(prepared.prefix, Handoff)
                    /\ targetTx' = "idle"
                    /\ response' \in {"activation", "none"}
                    /\ UNCHANGED <<source, sealed, prepared, sourceTx,
                                    certificate, daylight>>
AbortActivation == /\ targetTx = "activate" /\ targetTx' = "idle"
                   /\ UNCHANGED <<source, target, sealed, prepared, sourceTx,
                                   certificate, response, daylight>>
TargetWrite(op) == /\ op \in Writes \ Ops(target)
                   /\ Primary(target) = "B" /\ targetTx = "idle"
                   /\ target' = Append(target, op) /\ response' = "write"
                   /\ UNCHANGED <<source, sealed, prepared, sourceTx, targetTx,
                                   certificate, daylight>>

\* Returning an exact durable receipt is successful but never reapplies it.
\* Imported history carries receipts to the new primary, including old epochs.
RetryReceipt == /\ Ops(source) \cup Ops(target) # {}
                /\ response' = "receipt"
                /\ UNCHANGED <<source, target, sealed, prepared, sourceTx,
                                targetTx, certificate, daylight>>
RetryActivation == /\ Transferred(target) /\ response' = "activation"
                   /\ UNCHANGED <<source, target, sealed, prepared, sourceTx,
                                   targetTx, certificate, daylight>>
LoseResponse == /\ response # "none" /\ response' = "none"
                /\ UNCHANGED <<source, target, sealed, prepared, sourceTx,
                                targetTx, certificate, daylight>>
\* Crash/reopen preserves committed journals, receipts, preparation and seal;
\* both uncommitted transactions and browser-held responses are lost.
CrashRestart == /\ sourceTx' = "idle" /\ targetTx' = "idle"
                /\ certificate' = <<>> /\ response' = "none"
                /\ UNCHANGED <<source, target, sealed, prepared, daylight>>
\* Crossing a wall-clock/daylight boundary cannot retire the obligation.
DaylightPasses == /\ ~daylight /\ daylight' = TRUE
                  /\ UNCHANGED <<source, target, sealed, prepared, sourceTx,
                                  targetTx, certificate, response>>
Next == Reconcile \/ Prepare \/ (\E op \in Writes : SourceWrite(op))
        \/ BeginSeal \/ CommitSeal \/ AbortSeal \/ PublishStaged
        \/ RecoverFromJournal \/ BeginActivation \/ CommitActivation
        \/ AbortActivation \/ (\E op \in Writes : TargetWrite(op))
        \/ RetryReceipt \/ RetryActivation \/ LoseResponse \/ CrashRestart
        \/ DaylightPasses
Spec == Init /\ [][Next]_vars
\* Availability is conditional on repeated reads, retries, and commits getting
\* a chance to finish. No such fairness is assumed by the safety checks.
RecoverySpec == Spec /\ SF_vars(RecoverFromJournal)
                     /\ SF_vars(BeginActivation) /\ SF_vars(CommitActivation)

TypeOK == /\ source \in Seq(Writes \cup {Handoff}) /\ Len(source) <= 3
          /\ target \in Seq(Writes \cup {Handoff}) /\ Len(target) <= 3
          /\ sealed \in BOOLEAN /\ daylight \in BOOLEAN
          /\ prepared \in [exists : BOOLEAN, prefix : Seq(Writes)]
          /\ sourceTx \in {"idle", "seal"}
          /\ targetTx \in {"idle", "activate"}
          /\ certificate \in Seq(Writes \cup {Handoff})
          /\ response \in {"none", "write", "seal", "activation", "receipt"}
NoConcurrentLegitimateWriters ==
    ~(/\ ~sealed /\ Primary(source) = "A" /\ sourceTx = "idle"
      /\ Primary(target) = "B" /\ targetTx = "idle")
ActivationHasDurableSeal == Transferred(target) =>
    /\ sealed /\ Transferred(source) /\ Prefix(source, target)
ExactActivationPrefix == Transferred(target) =>
    Prefix(Append(prepared.prefix, Handoff), target)
NoDuplicateAppend == /\ Cardinality(Ops(source)) = Len(source)
                     /\ Cardinality(Ops(target)) = Len(target)
DurableHandoffCompletes == sealed ~> Transferred(target)
=============================================================================
