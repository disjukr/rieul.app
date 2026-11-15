----------------------------- MODULE Updater -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS MaxSteps, MaxAdmissions, Mutation
VARIABLES phase, mode, matchingIntent, holders, intent, exclusive,
          frozen, schedulerPaused, active, persistent, connected,
          admissions, grantAdmissions, validated, steps
vars == <<phase, mode, matchingIntent, holders, intent, exclusive,
          frozen, schedulerPaused, active, persistent, connected,
          admissions, grantAdmissions, validated, steps>>
Manual == matchingIntent /\ mode \in {"manual", "force"}
Force == Manual /\ mode = "force"
LeasePhases == {"Granted", "Committed", "Exiting", "Stopped", "ReadySwap", "Swapped"}
Busy == (~Manual /\ connected) \/ active \/ persistent
Init ==
    /\ phase = "Prepared"
    /\ mode \in {"automatic", "manual", "force"}
    /\ matchingIntent \in BOOLEAN
    /\ holders \in SUBSET {"compatible", "legacy"}
    /\ active \in BOOLEAN /\ persistent \in BOOLEAN /\ connected \in BOOLEAN
    /\ admissions = 0 /\ grantAdmissions = 0
    /\ intent = FALSE /\ exclusive = FALSE
    /\ frozen = FALSE /\ schedulerPaused = FALSE
    /\ validated = FALSE /\ steps = 0

(* Verification is an assumed primitive, not a model of codesign. *)
Validate ==
    /\ phase = "Prepared" /\ phase' = "Handoff"
    /\ validated' = TRUE /\ intent' = Force
    /\ UNCHANGED <<mode, matchingIntent, holders, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions>>
RejectCandidate ==
    /\ phase = "Prepared" /\ phase' = "Deferred"
    /\ UNCHANGED <<mode, matchingIntent, holders, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>

(* Compatible launchers recheck intent AFTER shared acquisition. A transient
   shared lock without a running child is omitted: it only delays the worker. *)
LaunchCompatible ==
    /\ phase \notin {"Deferred", "LegacyDeferred", "Swapped"}
    /\ ~intent /\ ~exclusive /\ "compatible" \notin holders
    /\ holders' = holders \cup {"compatible"}
    /\ UNCHANGED <<phase, mode, matchingIntent, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>
(* Legacy launchers ignore intent, not the OS exclusive lock. *)
LaunchLegacy ==
    /\ phase \notin {"Deferred", "LegacyDeferred", "Swapped"}
    /\ ~exclusive /\ "legacy" \notin holders
    /\ holders' = holders \cup {"legacy"}
    /\ UNCHANGED <<phase, mode, matchingIntent, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>
YieldCompatible ==
    /\ intent /\ "compatible" \in holders
    /\ holders' = holders \ {"compatible"}
    /\ UNCHANGED <<phase, mode, matchingIntent, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>
(* Owner closes a legacy/manual GUI. The worker cannot force this action. *)
CloseLegacy ==
    /\ "legacy" \in holders /\ holders' = holders \ {"legacy"}
    /\ UNCHANGED <<phase, mode, matchingIntent, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>
AcquireExclusive ==
    /\ phase = "Handoff"
    /\ (holders = {} \/ (Mutation = "skip-barrier" /\ Force))
    /\ exclusive' = TRUE /\ phase' = "Drain"
    /\ UNCHANGED <<mode, matchingIntent, holders, intent, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>

(* WorkGate freezes before the asynchronous live workload snapshot. *)
Freeze ==
    /\ phase = "Drain" /\ (~active \/ Force)
    /\ frozen' = TRUE /\ schedulerPaused' = TRUE /\ phase' = "Observing"
    /\ UNCHANGED <<mode, matchingIntent, holders, intent, exclusive,
                   active, persistent, connected, admissions, grantAdmissions, validated>>
NewWork ==
    /\ phase \in {"Prepared", "Handoff", "Drain", "Observing", "Granted", "Committed"}
    /\ (~frozen \/ Mutation = "open-admission")
    /\ ~active /\ admissions < MaxAdmissions
    /\ active' = TRUE /\ admissions' = admissions + 1
    /\ UNCHANGED <<phase, mode, matchingIntent, holders, intent, exclusive,
                   frozen, schedulerPaused, persistent, connected, grantAdmissions, validated>>
(* A call can finish and leave a live PTY/job. The live snapshot must see it. *)
FinishWork ==
    /\ phase \in {"Prepared", "Handoff", "Drain", "Observing", "Granted", "Committed"}
    /\ active /\ active' = FALSE /\ persistent' \in BOOLEAN
    /\ UNCHANGED <<phase, mode, matchingIntent, holders, intent, exclusive,
                   frozen, schedulerPaused, connected, admissions, grantAdmissions, validated>>
Grant ==
    /\ phase = "Observing" /\ (Force \/ ~Busy)
    /\ phase' = "Granted" /\ grantAdmissions' = admissions
    /\ UNCHANGED <<mode, matchingIntent, holders, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected, admissions, validated>>
Commit ==
    /\ phase = "Granted" /\ phase' = "Committed"
    /\ UNCHANGED <<mode, matchingIntent, holders, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>
AcknowledgeExit ==
    /\ phase = "Committed" /\ phase' = "Exiting"
    /\ UNCHANGED <<mode, matchingIntent, holders, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>
StopService ==
    /\ phase = "Exiting" /\ phase' = "Stopped" /\ intent' = FALSE
    /\ validated' = FALSE
    /\ UNCHANGED <<mode, matchingIntent, holders, exclusive, frozen,
                   schedulerPaused, active, persistent, connected, admissions, grantAdmissions>>
Revalidate ==
    /\ phase = "Stopped" /\ phase' = "ReadySwap" /\ validated' = TRUE
    /\ UNCHANGED <<mode, matchingIntent, holders, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected, admissions, grantAdmissions>>
Swap ==
    /\ phase = "ReadySwap" /\ validated /\ exclusive /\ phase' = "Swapped"
    /\ UNCHANGED <<mode, matchingIntent, holders, intent, exclusive, frozen,
                   schedulerPaused, active, persistent, connected,
                   admissions, grantAdmissions, validated>>

(* Busy, timeout, expired lease, worker handoff crash, failed revalidation, or
   automatic reconnect is a deferral, never authority to stop the daemon.
   Guard release is collapsed into one terminal action; recovery is omitted. *)
Defer ==
    /\ phase \in {"Handoff", "Drain", "Observing", "Granted", "Committed", "Stopped"}
    /\ phase' = "Deferred" /\ intent' = FALSE /\ exclusive' = FALSE
    /\ frozen' = FALSE /\ schedulerPaused' = FALSE
    /\ UNCHANGED <<mode, matchingIntent, holders, active, persistent,
                   connected, admissions, grantAdmissions, validated>>
(* Force wait_exclusive times out while a legacy shared holder remains.
   Unlike generic deferral this is an explicit barrier-refusal witness. *)
DeferLegacy ==
    /\ phase = "Handoff" /\ Force /\ "legacy" \in holders
    /\ phase' = "LegacyDeferred" /\ intent' = FALSE /\ exclusive' = FALSE
    /\ frozen' = FALSE /\ schedulerPaused' = FALSE
    /\ UNCHANGED <<mode, matchingIntent, holders, active, persistent,
                   connected, admissions, grantAdmissions, validated>>
Connect ==
    /\ phase \in {"Prepared", "Handoff", "Drain"} /\ ~connected
    /\ connected' = TRUE
    /\ UNCHANGED <<phase, mode, matchingIntent, holders, intent, exclusive,
                   frozen, schedulerPaused, active, persistent,
                   admissions, grantAdmissions, validated>>
AutomaticReconnect ==
    /\ phase \in {"Granted", "Committed"} /\ ~Manual
    /\ phase' = "Deferred" /\ connected' = TRUE
    /\ intent' = FALSE /\ exclusive' = FALSE
    /\ frozen' = FALSE /\ schedulerPaused' = FALSE
    /\ UNCHANGED <<mode, matchingIntent, holders, active, persistent,
                   admissions, grantAdmissions, validated>>
Next ==
    /\ steps < MaxSteps /\ steps' = steps + 1
    /\ (Validate \/ RejectCandidate \/ LaunchCompatible \/ LaunchLegacy \/
        YieldCompatible \/ CloseLegacy \/ AcquireExclusive \/ Freeze \/
        NewWork \/ FinishWork \/ Grant \/ Commit \/ AcknowledgeExit \/
        StopService \/ Revalidate \/ Swap \/ Defer \/ DeferLegacy \/ Connect \/ AutomaticReconnect)
Spec == Init /\ [][Next]_vars
TypeOK ==
    /\ phase \in {"Prepared", "Handoff", "Drain", "Observing", "Granted",
                  "Committed", "Exiting", "Stopped", "ReadySwap", "Swapped", "Deferred", "LegacyDeferred"}
    /\ mode \in {"automatic", "manual", "force"}
    /\ holders \subseteq {"compatible", "legacy"}
    /\ {matchingIntent, intent, exclusive, frozen, schedulerPaused,
         active, persistent, connected, validated} \subseteq BOOLEAN
    /\ admissions \in 0..MaxAdmissions /\ grantAdmissions \in 0..MaxAdmissions
    /\ steps \in 0..MaxSteps
ExclusiveNoGUI == exclusive => holders = {}
AdmissionFrozen == phase \in LeasePhases =>
    frozen /\ schedulerPaused /\ admissions = grantAdmissions
OrdinaryGrantIdle == phase \in LeasePhases /\ ~Force => ~Busy
SwapAuthorized == phase = "Swapped" =>
    exclusive /\ holders = {} /\ frozen /\ schedulerPaused /\ validated
(* Deliberately false invariants are reachability probes for corrected behavior. *)
NoForceBusySwap == ~(phase = "Swapped" /\ Force /\ persistent)
NoLegacyDeferral == ~(phase = "LegacyDeferred")
=============================================================================
