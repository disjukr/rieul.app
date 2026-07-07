use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, TimeZone};
use rrule::{Frequency, RRuleSet, Tz};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, watch, Mutex};
use wgo_daemon_core::rpc::{
    BulkJobMutationRes, BulkScheduleMutationRes, ClearJobsReq, ClearJobsRunningPolicy,
    ClearJobsScope, CommandExit, CommandExitReason, CommandLaunchSpec, CommandOutputCapture,
    CommandStdin, CreateJobReq, CreateScheduleReq, DeleteJobsReq, DeleteSchedulesReq,
    GetScheduleNextRunsReq, GetScheduleNextRunsRes, JobInfo, JobLogState, JobMutationResult,
    JobOutputEvent, JobOutputState, JobOutputStream, JobRunReason, JobStatus, KillJobReq,
    RunCommandReq, RunCommandRes, ScheduleArchiveFilter, ScheduleInfo, ScheduleMutationResult,
    ScheduleNextRunsContinuation, SubscribeJobOutputReq, SubscribeJobsReq, SubscribeSchedulesReq,
    UpdateScheduleReq,
};

use crate::state_db::{DaemonStateDb, StoredJobOutput};

const DEFAULT_RUN_TIMEOUT_MS: u64 = 1000;
const DEFAULT_RUN_OUTPUT_LIMIT: u64 = 64 * 1024;
const JOB_OUTPUT_READ_BUFFER: usize = 16 * 1024;
const DEFAULT_JOB_OUTPUT_LIMIT: u64 = 1024 * 1024;
const SCHEDULE_TICK: Duration = Duration::from_secs(1);
const NEXT_RUNS_MAX_LIMIT: u64 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandErrorKind {
    Failed,
    NotFound,
    PermissionDenied,
    ElevationUnavailable,
    InvalidLaunch,
    InvalidRRuleSet,
    LogDisabled,
}

#[derive(Debug, Clone)]
pub struct CommandError {
    pub kind: CommandErrorKind,
    pub message: String,
}

impl CommandError {
    fn new(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self::new(CommandErrorKind::Failed, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(CommandErrorKind::NotFound, message)
    }

    fn invalid_launch(message: impl Into<String>) -> Self {
        Self::new(CommandErrorKind::InvalidLaunch, message)
    }

    fn invalid_rrule(message: impl Into<String>) -> Self {
        Self::new(CommandErrorKind::InvalidRRuleSet, message)
    }
}

#[derive(Clone)]
pub struct CommandManager {
    db: Arc<StdMutex<DaemonStateDb>>,
    state: Arc<Mutex<CommandState>>,
    jobs_events: watch::Sender<u64>,
    schedules_events: watch::Sender<u64>,
    output_events: watch::Sender<u64>,
    next_id: Arc<AtomicU64>,
}

#[derive(Default)]
struct CommandState {
    jobs: BTreeMap<String, JobRecord>,
    schedules: BTreeMap<String, ScheduleRecord>,
}

struct JobRecord {
    info: JobInfo,
    stdout: RetainedOutput,
    stderr: RetainedOutput,
    kill: Option<oneshot::Sender<CommandExitReason>>,
}

struct ScheduleRecord {
    info: ScheduleInfo,
    last_checked_ms: u64,
}

#[derive(Clone)]
struct RetainedOutput {
    enabled: bool,
    max_bytes: u64,
    chunks: VecDeque<OutputChunk>,
    state: JobOutputState,
}

#[derive(Clone)]
struct OutputChunk {
    seq: u64,
    bytes: Vec<u8>,
}

impl RetainedOutput {
    fn new(enabled: bool, max_bytes: Option<u64>) -> Self {
        Self {
            enabled,
            max_bytes: max_bytes.unwrap_or(DEFAULT_JOB_OUTPUT_LIMIT),
            chunks: VecDeque::new(),
            state: JobOutputState {
                enabled,
                oldest_seq: 0,
                latest_seq: 0,
                retained_bytes: 0,
                truncated: false,
            },
        }
    }

    fn from_persisted(enabled: bool, persisted: Option<StoredJobOutput>) -> Self {
        let Some(persisted) = persisted else {
            return Self::new(enabled, None);
        };
        Self {
            enabled: persisted.state.enabled,
            max_bytes: DEFAULT_JOB_OUTPUT_LIMIT,
            chunks: persisted
                .chunks
                .into_iter()
                .map(|chunk| OutputChunk {
                    seq: chunk.seq,
                    bytes: chunk.bytes,
                })
                .collect(),
            state: persisted.state,
        }
    }

    fn append(&mut self, bytes: Vec<u8>) -> Option<OutputChunk> {
        if !self.enabled || bytes.is_empty() {
            return None;
        }
        let seq = self.state.latest_seq.saturating_add(1);
        self.state.latest_seq = seq;
        if self.state.oldest_seq == 0 {
            self.state.oldest_seq = seq;
        }
        self.state.retained_bytes = self.state.retained_bytes.saturating_add(bytes.len() as u64);
        let chunk = OutputChunk { seq, bytes };
        self.chunks.push_back(chunk.clone());
        while self.state.retained_bytes > self.max_bytes {
            let Some(removed) = self.chunks.pop_front() else {
                break;
            };
            self.state.retained_bytes = self
                .state
                .retained_bytes
                .saturating_sub(removed.bytes.len() as u64);
            self.state.truncated = true;
            self.state.oldest_seq = self.chunks.front().map(|chunk| chunk.seq).unwrap_or(0);
        }
        self.chunks
            .back()
            .filter(|retained| retained.seq == seq)
            .cloned()
    }

    fn chunks_after(&self, after_seq: Option<u64>) -> (bool, Vec<OutputChunk>) {
        let after_seq = after_seq.unwrap_or(0);
        let gap = self.state.oldest_seq > 0 && after_seq > 0 && after_seq < self.state.oldest_seq;
        let chunks = self
            .chunks
            .iter()
            .filter(|chunk| chunk.seq > after_seq)
            .cloned()
            .collect();
        (gap, chunks)
    }
}

impl CommandManager {
    pub fn open(db: DaemonStateDb) -> Result<Self> {
        let schedules = db
            .load_schedules()?
            .into_iter()
            .map(|info| {
                (
                    info.schedule_id.clone(),
                    ScheduleRecord {
                        info,
                        last_checked_ms: current_unix_ms(),
                    },
                )
            })
            .collect();
        let mut jobs = BTreeMap::new();
        let now = current_unix_ms();
        for mut info in db.load_jobs()? {
            if matches!(info.status, JobStatus::Running) {
                let exit = CommandExit {
                    code: None,
                    signal: None,
                    reason: CommandExitReason::DaemonShuttingDown,
                    exited_at_ms: now,
                };
                info.status = JobStatus::Exited { exit };
                info.finished_at_ms = Some(now);
                db.save_job(&info)?;
            }
            let stdout = RetainedOutput::from_persisted(
                info.log.stdout.enabled,
                db.load_job_output(&info.job_id, JobOutputStream::Stdout)?,
            );
            let stderr = RetainedOutput::from_persisted(
                info.log.stderr.enabled,
                db.load_job_output(&info.job_id, JobOutputStream::Stderr)?,
            );
            jobs.insert(
                info.job_id.clone(),
                JobRecord {
                    stdout,
                    stderr,
                    info,
                    kill: None,
                },
            );
        }

        let (jobs_events, _) = watch::channel(0);
        let (schedules_events, _) = watch::channel(0);
        let (output_events, _) = watch::channel(0);
        Ok(Self {
            db: Arc::new(StdMutex::new(db)),
            state: Arc::new(Mutex::new(CommandState { jobs, schedules })),
            jobs_events,
            schedules_events,
            output_events,
            next_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub fn start_scheduler(&self) -> tokio::task::JoinHandle<()> {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(SCHEDULE_TICK);
            loop {
                interval.tick().await;
                manager.run_due_schedules().await;
            }
        })
    }

    pub async fn run_command(&self, request: RunCommandReq) -> Result<RunCommandRes, CommandError> {
        self.run_command_until(request, std::future::pending::<()>())
            .await
    }

    pub async fn run_command_until<F>(
        &self,
        request: RunCommandReq,
        cancel: F,
    ) -> Result<RunCommandRes, CommandError>
    where
        F: Future<Output = ()> + Send,
    {
        validate_launch(&request.launch)?;
        if request.launch.elevated.unwrap_or(false) {
            return Err(CommandError::new(
                CommandErrorKind::ElevationUnavailable,
                "elevated command execution is not implemented yet",
            ));
        }
        let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_RUN_TIMEOUT_MS));
        let stdout_limit = request.max_stdout_bytes.unwrap_or(DEFAULT_RUN_OUTPUT_LIMIT);
        let stderr_limit = request.max_stderr_bytes.unwrap_or(DEFAULT_RUN_OUTPUT_LIMIT);
        let mut command = build_command(&request.launch)?;
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|err| CommandError::failed(format!("failed to spawn command: {err}")))?;
        let stdout = child
            .stdout
            .take()
            .map(|stdout| tokio::spawn(read_capture_limited(stdout, stdout_limit)));
        let stderr = child
            .stderr
            .take()
            .map(|stderr| tokio::spawn(read_capture_limited(stderr, stderr_limit)));
        tokio::pin!(cancel);
        let timeout_sleep = tokio::time::sleep(timeout);
        tokio::pin!(timeout_sleep);
        let mut stdin = spawn_stdin_writer(child.stdin.take(), request.launch.stdin.clone());
        let mut stdin_done = false;

        let exit = loop {
            let exit = tokio::select! {
                status = child.wait() => match status {
                    Ok(status) => Some(CommandExit {
                        code: status.code().map(i64::from),
                        signal: None,
                        reason: CommandExitReason::ProcessExit,
                        exited_at_ms: current_unix_ms(),
                    }),
                    Err(err) => {
                        return Err(CommandError::failed(format!(
                            "failed to wait for command: {err}"
                        )));
                    }
                },
                stdin_result = &mut stdin, if !stdin_done => {
                    stdin_done = true;
                    match stdin_result {
                        Ok(Ok(())) => None,
                        Ok(Err(err)) => {
                            let _ = child.start_kill();
                            let _ = child.wait().await;
                            let _ = await_capture(stdout).await;
                            let _ = await_capture(stderr).await;
                            return Err(err);
                        }
                        Err(err) => {
                            let _ = child.start_kill();
                            let _ = child.wait().await;
                            let _ = await_capture(stdout).await;
                            let _ = await_capture(stderr).await;
                            return Err(CommandError::failed(format!(
                                "failed to write stdin: {err}"
                            )));
                        }
                    }
                },
                _ = &mut timeout_sleep => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    Some(CommandExit {
                        code: None,
                        signal: None,
                        reason: CommandExitReason::Timeout,
                        exited_at_ms: current_unix_ms(),
                    })
                },
                _ = &mut cancel => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    Some(CommandExit {
                        code: None,
                        signal: None,
                        reason: CommandExitReason::UserKill,
                        exited_at_ms: current_unix_ms(),
                    })
                },
            };
            if let Some(exit) = exit {
                if !stdin_done {
                    stdin.abort();
                }
                break exit;
            }
        };
        Ok(RunCommandRes {
            exit,
            stdout: await_capture(stdout).await,
            stderr: await_capture(stderr).await,
        })
    }

    pub async fn create_job(&self, request: CreateJobReq) -> Result<JobInfo, CommandError> {
        self.create_job_with_reason(request, JobRunReason::Manual)
            .await
    }

    pub async fn create_schedule(
        &self,
        request: CreateScheduleReq,
    ) -> Result<ScheduleInfo, CommandError> {
        validate_launch(&request.launch)?;
        if request.launch.elevated.unwrap_or(false) {
            return Err(CommandError::new(
                CommandErrorKind::ElevationUnavailable,
                "elevated command execution is not implemented yet",
            ));
        }
        parse_rrule_set(&request.rrule_set)?;
        let now = current_unix_ms();
        let schedule = ScheduleInfo {
            schedule_id: next_id("schedule", &self.next_id),
            title: request.title,
            launch: request.launch,
            job: request.job,
            rrule_set: request.rrule_set,
            enabled: request.enabled,
            archived: false,
            created_at_ms: now,
            updated_at_ms: now,
            note: request.note,
        };
        self.save_schedule(schedule.clone()).await?;
        Ok(schedule)
    }

    pub async fn update_schedule(
        &self,
        request: UpdateScheduleReq,
    ) -> Result<ScheduleInfo, CommandError> {
        let mut state = self.state.lock().await;
        let Some(record) = state.schedules.get_mut(&request.schedule_id) else {
            return Err(CommandError::not_found("schedule not found"));
        };
        let mut schedule = record.info.clone();
        if let Some(title) = request.title {
            schedule.title = title;
        }
        if let Some(launch) = request.launch {
            validate_launch(&launch)?;
            if launch.elevated.unwrap_or(false) {
                return Err(CommandError::new(
                    CommandErrorKind::ElevationUnavailable,
                    "elevated command execution is not implemented yet",
                ));
            }
            schedule.launch = launch;
        }
        if let Some(job) = request.job {
            schedule.job = job;
        }
        if let Some(rrule_set) = request.rrule_set {
            parse_rrule_set(&rrule_set)?;
            schedule.rrule_set = rrule_set;
        }
        if let Some(enabled) = request.enabled {
            schedule.enabled = enabled;
        }
        if let Some(archived) = request.archived {
            schedule.archived = archived;
        }
        if let Some(note) = request.note {
            schedule.note = Some(note);
        }
        let previous = (record.info.clone(), record.last_checked_ms);
        schedule.updated_at_ms = current_unix_ms();
        record.info = schedule.clone();
        record.last_checked_ms = current_unix_ms();
        drop(state);
        if let Err(err) = self.persist_schedule(&schedule) {
            let mut state = self.state.lock().await;
            if let Some(record) = state.schedules.get_mut(&request.schedule_id) {
                record.info = previous.0;
                record.last_checked_ms = previous.1;
            }
            return Err(err);
        }
        self.notify_schedules();
        Ok(schedule)
    }

    pub async fn delete_schedules(&self, request: DeleteSchedulesReq) -> BulkScheduleMutationRes {
        let mut results = Vec::new();
        for schedule_id in request.schedule_ids {
            let removed = self.delete_schedule_and_jobs(&schedule_id).await;
            results.push(match removed {
                Ok(true) => ScheduleMutationResult::Deleted { schedule_id },
                Ok(false) => ScheduleMutationResult::Failed {
                    schedule_id,
                    message: "schedule not found".to_string(),
                },
                Err(err) => ScheduleMutationResult::Failed {
                    schedule_id,
                    message: err.message,
                },
            });
        }
        BulkScheduleMutationRes { results }
    }

    pub async fn kill_job(&self, request: KillJobReq) -> Result<(), CommandError> {
        let mut state = self.state.lock().await;
        let Some(record) = state.jobs.get_mut(&request.job_id) else {
            return Err(CommandError::not_found("job not found"));
        };
        if let Some(kill) = record.kill.take() {
            let _ = kill.send(CommandExitReason::UserKill);
        }
        Ok(())
    }

    pub async fn delete_jobs(&self, request: DeleteJobsReq) -> BulkJobMutationRes {
        let mut results = Vec::new();
        for job_id in request.job_ids {
            let result = self.delete_job(&job_id, request.kill_running).await;
            results.push(match result {
                Ok(DeleteJobOutcome::Deleted) => JobMutationResult::Deleted { job_id },
                Ok(DeleteJobOutcome::KilledAndDeleted) => {
                    JobMutationResult::KilledAndDeleted { job_id }
                }
                Err(err) => JobMutationResult::Failed {
                    job_id,
                    message: err.message,
                },
            });
        }
        BulkJobMutationRes { results }
    }

    pub async fn clear_jobs(&self, request: ClearJobsReq) -> BulkJobMutationRes {
        let job_ids = {
            let state = self.state.lock().await;
            state
                .jobs
                .values()
                .filter(|record| match &request.scope {
                    ClearJobsScope::All => true,
                    ClearJobsScope::BySchedule { schedule_id } => match &record.info.reason {
                        JobRunReason::Schedule {
                            schedule_id: id, ..
                        } => id == schedule_id,
                        JobRunReason::Manual => false,
                    },
                })
                .filter(|record| {
                    request.running == ClearJobsRunningPolicy::Kill
                        || !matches!(record.info.status, JobStatus::Running)
                })
                .map(|record| record.info.job_id.clone())
                .collect::<Vec<_>>()
        };
        self.delete_jobs(DeleteJobsReq {
            job_ids,
            kill_running: request.running == ClearJobsRunningPolicy::Kill,
        })
        .await
    }

    pub async fn get_schedule_next_runs(
        &self,
        request: GetScheduleNextRunsReq,
    ) -> Result<GetScheduleNextRunsRes, CommandError> {
        let schedule = {
            let state = self.state.lock().await;
            state
                .schedules
                .get(&request.schedule_id)
                .map(|record| record.info.clone())
        }
        .ok_or_else(|| CommandError::not_found("schedule not found"))?;
        let rule = parse_rrule_set(&schedule.rrule_set)?;
        Ok(next_runs_for_rule(&rule, request))
    }

    pub async fn jobs_snapshot(&self, request: &SubscribeJobsReq) -> JobsSnapshot {
        let state = self.state.lock().await;
        let rows = state
            .jobs
            .values()
            .filter(|record| {
                request.schedule_id.as_ref().is_none_or(|schedule_id| {
                    matches!(
                        &record.info.reason,
                        JobRunReason::Schedule { schedule_id: id, .. } if id == schedule_id
                    )
                })
            })
            .map(|record| record.info.clone())
            .collect();
        JobsSnapshot { rows }
    }

    pub async fn schedules_snapshot(&self, request: &SubscribeSchedulesReq) -> SchedulesSnapshot {
        let state = self.state.lock().await;
        let rows = state
            .schedules
            .values()
            .filter(|record| match request.archived {
                ScheduleArchiveFilter::ActiveOnly => !record.info.archived,
                ScheduleArchiveFilter::ArchivedOnly => record.info.archived,
                ScheduleArchiveFilter::All => true,
            })
            .map(|record| record.info.clone())
            .collect();
        SchedulesSnapshot { rows }
    }

    pub fn subscribe_jobs_events(&self) -> watch::Receiver<u64> {
        self.jobs_events.subscribe()
    }

    pub fn subscribe_schedules_events(&self) -> watch::Receiver<u64> {
        self.schedules_events.subscribe()
    }

    pub fn subscribe_output_events(&self) -> watch::Receiver<u64> {
        self.output_events.subscribe()
    }

    pub async fn output_attached(
        &self,
        request: &SubscribeJobOutputReq,
    ) -> Result<(JobInfo, JobOutputState, Vec<JobOutputEvent>), CommandError> {
        let state = self.state.lock().await;
        let record = state
            .jobs
            .get(&request.job_id)
            .ok_or_else(|| CommandError::not_found("job not found"))?;
        let output = record.output(request.stream);
        if !output.enabled {
            return Err(CommandError::new(
                CommandErrorKind::LogDisabled,
                "job output stream is disabled",
            ));
        }
        let (gap, chunks) = output.chunks_after(request.after_seq);
        let mut events = Vec::new();
        events.push(JobOutputEvent::Attached {
            job: record.info.clone(),
            oldest_seq: output.state.oldest_seq,
            latest_seq: output.state.latest_seq,
        });
        if gap {
            events.push(JobOutputEvent::HistoryGap {
                next_seq: output.state.oldest_seq,
            });
        }
        events.extend(chunks.into_iter().map(|chunk| JobOutputEvent::Chunk {
            seq: chunk.seq,
            bytes: chunk.bytes,
        }));
        if output.state.truncated {
            events.push(JobOutputEvent::Truncated);
        }
        if let JobStatus::Exited { exit } = &record.info.status {
            events.push(JobOutputEvent::JobExited { exit: exit.clone() });
        }
        Ok((record.info.clone(), output.state.clone(), events))
    }

    pub async fn output_chunks_after(
        &self,
        job_id: &str,
        stream: JobOutputStream,
        after_seq: u64,
    ) -> Result<(JobInfo, Vec<JobOutputEvent>), CommandError> {
        let state = self.state.lock().await;
        let record = state
            .jobs
            .get(job_id)
            .ok_or_else(|| CommandError::not_found("job not found"))?;
        let output = record.output(stream);
        let (gap, chunks) = output.chunks_after(Some(after_seq));
        let mut events = Vec::new();
        if gap {
            events.push(JobOutputEvent::HistoryGap {
                next_seq: output.state.oldest_seq,
            });
        }
        let chunks_empty = chunks.is_empty();
        events.extend(chunks.into_iter().map(|chunk| JobOutputEvent::Chunk {
            seq: chunk.seq,
            bytes: chunk.bytes,
        }));
        if chunks_empty && output.state.truncated && output.state.latest_seq > after_seq {
            if events.is_empty() {
                events.push(JobOutputEvent::HistoryGap {
                    next_seq: output.state.latest_seq,
                });
            }
            events.push(JobOutputEvent::Truncated);
        }
        if let JobStatus::Exited { exit } = &record.info.status {
            events.push(JobOutputEvent::JobExited { exit: exit.clone() });
        }
        Ok((record.info.clone(), events))
    }

    async fn create_job_with_reason(
        &self,
        request: CreateJobReq,
        reason: JobRunReason,
    ) -> Result<JobInfo, CommandError> {
        validate_launch(&request.launch)?;
        if request.launch.elevated.unwrap_or(false) {
            return Err(CommandError::new(
                CommandErrorKind::ElevationUnavailable,
                "elevated command execution is not implemented yet",
            ));
        }
        let now = current_unix_ms();
        let job = JobInfo {
            job_id: next_id("job", &self.next_id),
            title: request.title.clone(),
            launch: request.launch.clone(),
            created_at_ms: now,
            started_at_ms: Some(now),
            finished_at_ms: None,
            status: JobStatus::Running,
            reason,
            log: JobLogState {
                stdout: JobOutputState {
                    enabled: request.log.stdout,
                    ..JobOutputState::default()
                },
                stderr: JobOutputState {
                    enabled: request.log.stderr,
                    ..JobOutputState::default()
                },
            },
        };
        let (kill_tx, kill_rx) = oneshot::channel();
        self.persist_job(&job)?;
        {
            let mut state = self.state.lock().await;
            state.jobs.insert(
                job.job_id.clone(),
                JobRecord {
                    stdout: RetainedOutput::new(request.log.stdout, request.log.max_stdout_bytes),
                    stderr: RetainedOutput::new(request.log.stderr, request.log.max_stderr_bytes),
                    info: job.clone(),
                    kill: Some(kill_tx),
                },
            );
        }
        self.notify_jobs();
        self.spawn_job_task(job.job_id.clone(), request, kill_rx);
        Ok(job)
    }

    fn spawn_job_task(
        &self,
        job_id: String,
        request: CreateJobReq,
        kill_rx: oneshot::Receiver<CommandExitReason>,
    ) {
        let manager = self.clone();
        tokio::spawn(async move {
            let exit = manager.run_job_process(&job_id, request, kill_rx).await;
            manager.finish_job(&job_id, exit).await;
        });
    }

    async fn run_job_process(
        &self,
        job_id: &str,
        request: CreateJobReq,
        mut kill_rx: oneshot::Receiver<CommandExitReason>,
    ) -> CommandExit {
        let mut command = match build_command(&request.launch) {
            Ok(command) => command,
            Err(err) => {
                return CommandExit {
                    code: None,
                    signal: None,
                    reason: CommandExitReason::SpawnFailed,
                    exited_at_ms: current_unix_ms(),
                }
                .with_error_log(self, job_id, err.message)
                .await;
            }
        };
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                return CommandExit {
                    code: None,
                    signal: None,
                    reason: CommandExitReason::SpawnFailed,
                    exited_at_ms: current_unix_ms(),
                }
                .with_error_log(self, job_id, format!("failed to spawn command: {err}"))
                .await;
            }
        };
        let mut output_readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            output_readers.push(spawn_output_reader(
                self.clone(),
                job_id.to_string(),
                JobOutputStream::Stdout,
                stdout,
            ));
        }
        if let Some(stderr) = child.stderr.take() {
            output_readers.push(spawn_output_reader(
                self.clone(),
                job_id.to_string(),
                JobOutputStream::Stderr,
                stderr,
            ));
        }
        let timeout = request.timeout_ms.map(Duration::from_millis);
        let mut timeout_sleep = Box::pin(async {
            if let Some(timeout) = timeout {
                tokio::time::sleep(timeout).await;
            } else {
                std::future::pending::<()>().await;
            }
        });
        let mut stdin = spawn_stdin_writer(child.stdin.take(), request.launch.stdin.clone());
        let mut stdin_done = false;

        let exit = loop {
            let exit = tokio::select! {
                status = child.wait() => {
                    match status {
                        Ok(status) => Some(CommandExit {
                            code: status.code().map(i64::from),
                            signal: None,
                            reason: CommandExitReason::ProcessExit,
                            exited_at_ms: current_unix_ms(),
                        }),
                        Err(_) => Some(CommandExit {
                            code: None,
                            signal: None,
                            reason: CommandExitReason::SpawnFailed,
                            exited_at_ms: current_unix_ms(),
                        }),
                    }
                }
                stdin_result = &mut stdin, if !stdin_done => {
                    stdin_done = true;
                    match stdin_result {
                        Ok(Ok(())) => None,
                        Ok(Err(err)) => {
                            self.append_output(
                                job_id,
                                JobOutputStream::Stderr,
                                format!("failed to write stdin: {}\n", err.message).into_bytes(),
                            )
                            .await;
                            None
                        }
                        Err(err) => {
                            self.append_output(
                                job_id,
                                JobOutputStream::Stderr,
                                format!("failed to write stdin: {err}\n").into_bytes(),
                            )
                            .await;
                            None
                        }
                    }
                }
                reason = &mut kill_rx => {
                    let reason = reason.unwrap_or(CommandExitReason::UserKill);
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    Some(CommandExit { code: None, signal: None, reason, exited_at_ms: current_unix_ms() })
                }
                _ = &mut timeout_sleep => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    Some(CommandExit { code: None, signal: None, reason: CommandExitReason::Timeout, exited_at_ms: current_unix_ms() })
                }
            };
            if let Some(exit) = exit {
                if !stdin_done {
                    stdin.abort();
                }
                break exit;
            }
        };
        await_output_readers(output_readers).await;
        exit
    }

    async fn finish_job(&self, job_id: &str, exit: CommandExit) {
        let mut maybe_job = None;
        {
            let mut state = self.state.lock().await;
            if let Some(record) = state.jobs.get_mut(job_id) {
                record.info.status = JobStatus::Exited { exit: exit.clone() };
                record.info.finished_at_ms = Some(exit.exited_at_ms);
                record.kill = None;
                record.info.log.stdout = record.stdout.state.clone();
                record.info.log.stderr = record.stderr.state.clone();
                maybe_job = Some(record.info.clone());
            }
        }
        if let Some(job) = maybe_job {
            let _ = self.persist_job(&job);
            self.notify_jobs();
            self.notify_output();
        }
    }

    async fn append_output(&self, job_id: &str, stream: JobOutputStream, bytes: Vec<u8>) {
        let mut chunk_to_persist = None;
        let mut state_to_persist = None;
        {
            let mut state = self.state.lock().await;
            if let Some(record) = state.jobs.get_mut(job_id) {
                let output = record.output_mut(stream);
                let chunk = output.append(bytes);
                if chunk.is_some() || output.state.latest_seq > 0 {
                    let output_state = output.state.clone();
                    let _ = output;
                    record.info.log.stdout = record.stdout.state.clone();
                    record.info.log.stderr = record.stderr.state.clone();
                    chunk_to_persist = chunk;
                    state_to_persist = Some(output_state);
                }
            }
        }
        let output_changed = state_to_persist.is_some();
        if let Some(state) = state_to_persist {
            let _ = self.persist_job_output_state(job_id, stream, &state);
        }
        if let Some(chunk) = chunk_to_persist {
            let _ = self.persist_job_output_chunk(job_id, stream, &chunk);
        }
        if output_changed {
            self.notify_output();
        }
    }

    async fn save_schedule(&self, schedule: ScheduleInfo) -> Result<(), CommandError> {
        self.persist_schedule(&schedule)?;
        {
            let mut state = self.state.lock().await;
            state.schedules.insert(
                schedule.schedule_id.clone(),
                ScheduleRecord {
                    info: schedule.clone(),
                    last_checked_ms: current_unix_ms(),
                },
            );
        }
        self.notify_schedules();
        Ok(())
    }

    async fn delete_schedule_and_jobs(&self, schedule_id: &str) -> Result<bool, CommandError> {
        let job_ids = {
            let state = self.state.lock().await;
            if !state.schedules.contains_key(schedule_id) {
                return Ok(false);
            }
            state
                .jobs
                .values()
                .filter_map(|record| match &record.info.reason {
                    JobRunReason::Schedule {
                        schedule_id: id, ..
                    } if id == schedule_id => Some(record.info.job_id.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        for job_id in job_ids {
            let _ = self.delete_job(&job_id, true).await;
        }
        {
            let mut state = self.state.lock().await;
            state.schedules.remove(schedule_id);
        }
        self.with_db(|db| db.delete_schedule(schedule_id))
            .map_err(|err| CommandError::failed(err.to_string()))?;
        self.notify_schedules();
        Ok(true)
    }

    async fn delete_job(
        &self,
        job_id: &str,
        kill_running: bool,
    ) -> Result<DeleteJobOutcome, CommandError> {
        let mut killed = false;
        {
            let mut state = self.state.lock().await;
            let Some(record) = state.jobs.get_mut(job_id) else {
                return Err(CommandError::not_found("job not found"));
            };
            if matches!(record.info.status, JobStatus::Running) {
                if !kill_running {
                    return Err(CommandError::failed("job is still running"));
                }
                if let Some(kill) = record.kill.take() {
                    let _ = kill.send(CommandExitReason::UserKill);
                }
                killed = true;
            }
            state.jobs.remove(job_id);
        }
        self.with_db(|db| db.delete_job(job_id))
            .map_err(|err| CommandError::failed(err.to_string()))?;
        self.notify_jobs();
        self.notify_output();
        Ok(if killed {
            DeleteJobOutcome::KilledAndDeleted
        } else {
            DeleteJobOutcome::Deleted
        })
    }

    fn persist_schedule(&self, schedule: &ScheduleInfo) -> Result<(), CommandError> {
        self.with_db(|db| db.save_schedule(schedule))
            .map_err(|err| CommandError::failed(err.to_string()))
    }

    fn persist_job(&self, job: &JobInfo) -> Result<(), CommandError> {
        self.with_db(|db| db.save_job(job))
            .map_err(|err| CommandError::failed(err.to_string()))
    }

    fn persist_job_output_state(
        &self,
        job_id: &str,
        stream: JobOutputStream,
        state: &JobOutputState,
    ) -> Result<(), CommandError> {
        self.with_db(|db| db.save_job_output_state(job_id, stream, state))
            .map_err(|err| CommandError::failed(err.to_string()))
    }

    fn persist_job_output_chunk(
        &self,
        job_id: &str,
        stream: JobOutputStream,
        chunk: &OutputChunk,
    ) -> Result<(), CommandError> {
        self.with_db(|db| {
            db.append_job_output_chunk(job_id, stream, chunk.seq, &chunk.bytes, current_unix_ms())
        })
        .map_err(|err| CommandError::failed(err.to_string()))
    }

    fn with_db<T>(&self, f: impl FnOnce(&DaemonStateDb) -> Result<T>) -> Result<T> {
        let db = self
            .db
            .lock()
            .expect("daemon state database mutex poisoned");
        f(&db)
    }

    fn notify_jobs(&self) {
        let _ = self
            .jobs_events
            .send(self.jobs_events.borrow().wrapping_add(1));
    }

    fn notify_schedules(&self) {
        let _ = self
            .schedules_events
            .send(self.schedules_events.borrow().wrapping_add(1));
    }

    fn notify_output(&self) {
        let _ = self
            .output_events
            .send(self.output_events.borrow().wrapping_add(1));
    }

    async fn run_due_schedules(&self) {
        let now = current_unix_ms();
        let due = {
            let mut state = self.state.lock().await;
            let mut due = Vec::new();
            for record in state.schedules.values_mut() {
                if !record.info.enabled || record.info.archived {
                    record.last_checked_ms = now;
                    continue;
                }
                let Ok(rule) = parse_rrule_set(&record.info.rrule_set) else {
                    record.last_checked_ms = now;
                    continue;
                };
                let request = GetScheduleNextRunsReq {
                    schedule_id: record.info.schedule_id.clone(),
                    limit: 16,
                    from_ms: Some(record.last_checked_ms),
                    search_until_ms: Some(now),
                };
                let runs = next_runs_for_rule(&rule, request);
                record.last_checked_ms = next_schedule_checkpoint(now, &runs);
                for _ in runs.run_at_ms {
                    due.push(record.info.clone());
                }
            }
            due
        };
        for schedule in due {
            let request = CreateJobReq {
                launch: schedule.launch.clone(),
                timeout_ms: schedule.job.timeout_ms,
                log: schedule.job.log.clone(),
                title: Some(schedule.title.clone()),
            };
            let reason = JobRunReason::Schedule {
                schedule_id: schedule.schedule_id.clone(),
                rrule_set: schedule.rrule_set.clone(),
            };
            let _ = self.create_job_with_reason(request, reason).await;
        }
    }
}

pub struct JobsSnapshot {
    pub rows: Vec<JobInfo>,
}

pub struct SchedulesSnapshot {
    pub rows: Vec<ScheduleInfo>,
}

enum DeleteJobOutcome {
    Deleted,
    KilledAndDeleted,
}

impl JobRecord {
    fn output(&self, stream: JobOutputStream) -> &RetainedOutput {
        match stream {
            JobOutputStream::Stdout => &self.stdout,
            JobOutputStream::Stderr => &self.stderr,
        }
    }

    fn output_mut(&mut self, stream: JobOutputStream) -> &mut RetainedOutput {
        match stream {
            JobOutputStream::Stdout => &mut self.stdout,
            JobOutputStream::Stderr => &mut self.stderr,
        }
    }
}

trait CommandExitExt {
    async fn with_error_log(
        self,
        manager: &CommandManager,
        job_id: &str,
        message: String,
    ) -> CommandExit;
}

impl CommandExitExt for CommandExit {
    async fn with_error_log(
        self,
        manager: &CommandManager,
        job_id: &str,
        message: String,
    ) -> CommandExit {
        manager
            .append_output(
                job_id,
                JobOutputStream::Stderr,
                format!("{message}\n").into_bytes(),
            )
            .await;
        self
    }
}

fn build_command(launch: &CommandLaunchSpec) -> Result<Command, CommandError> {
    validate_launch(launch)?;
    let mut command = Command::new(&launch.command);
    command.args(&launch.args);
    if let Some(cwd) = &launch.cwd {
        command.current_dir(PathBuf::from(cwd));
    }
    if let Some(env) = &launch.env {
        for unset in &env.unset {
            command.env_remove(unset);
        }
        for set in &env.set {
            command.env(&set.name, &set.value);
        }
    }
    Ok(command)
}

fn validate_launch(launch: &CommandLaunchSpec) -> Result<(), CommandError> {
    if launch.command.trim().is_empty() {
        return Err(CommandError::invalid_launch("command must not be empty"));
    }
    if launch.command.contains('\0') || launch.args.iter().any(|arg| arg.contains('\0')) {
        return Err(CommandError::invalid_launch("command contains NUL byte"));
    }
    Ok(())
}

fn spawn_stdin_writer(
    child_stdin: Option<ChildStdin>,
    stdin: Option<CommandStdin>,
) -> tokio::task::JoinHandle<Result<(), CommandError>> {
    tokio::spawn(async move {
        let Some(stdin) = stdin else {
            drop(child_stdin);
            return Ok(());
        };
        let Some(mut child_stdin) = child_stdin else {
            return Ok(());
        };
        let bytes = match stdin {
            CommandStdin::Text { text } => text.into_bytes(),
            CommandStdin::Bytes { bytes } => bytes,
        };
        child_stdin
            .write_all(&bytes)
            .await
            .map_err(|err| CommandError::failed(format!("failed to write stdin: {err}")))?;
        drop(child_stdin);
        Ok(())
    })
}

async fn read_capture_limited<R>(mut reader: R, limit: u64) -> CommandOutputCapture
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = vec![0; JOB_OUTPUT_READ_BUFFER];
    let mut bytes = Vec::new();
    let mut truncated = false;
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(read) => read,
            Err(_) => break,
        };
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len() as u64) as usize;
        if remaining == 0 {
            truncated = true;
            continue;
        }
        let keep = read.min(remaining);
        bytes.extend_from_slice(&buffer[..keep]);
        if keep < read {
            truncated = true;
        }
    }
    CommandOutputCapture { bytes, truncated }
}

async fn await_capture(
    task: Option<tokio::task::JoinHandle<CommandOutputCapture>>,
) -> CommandOutputCapture {
    match task {
        Some(task) => task.await.unwrap_or(CommandOutputCapture {
            bytes: Vec::new(),
            truncated: false,
        }),
        None => CommandOutputCapture {
            bytes: Vec::new(),
            truncated: false,
        },
    }
}

fn spawn_output_reader<R>(
    manager: CommandManager,
    job_id: String,
    stream: JobOutputStream,
    mut reader: R,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buffer = vec![0; JOB_OUTPUT_READ_BUFFER];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(n) => {
                    manager
                        .append_output(&job_id, stream, buffer[..n].to_vec())
                        .await
                }
                Err(_) => break,
            }
        }
    })
}

async fn await_output_readers(readers: Vec<tokio::task::JoinHandle<()>>) {
    for reader in readers {
        let _ = reader.await;
    }
}

fn next_id(prefix: &str, next_id: &AtomicU64) -> String {
    let counter = next_id.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{counter}", current_unix_ms())
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[derive(Debug, Clone)]
struct ParsedRRuleSet {
    set: RRuleSet,
    horizon_freq: Frequency,
}

fn parse_rrule_set(text: &str) -> Result<ParsedRRuleSet, CommandError> {
    let set = RRuleSet::new(unix_ms_to_datetime(current_unix_ms()))
        .set_from_string(text)
        .map_err(|err| CommandError::invalid_rrule(err.to_string()))?;
    let horizon_freq = set
        .get_rrule()
        .iter()
        .map(|rule| rule.get_freq())
        .max()
        .unwrap_or(Frequency::Yearly);
    Ok(ParsedRRuleSet { set, horizon_freq })
}

fn next_runs_for_rule(
    rule: &ParsedRRuleSet,
    request: GetScheduleNextRunsReq,
) -> GetScheduleNextRunsRes {
    let limit = request.limit.clamp(1, NEXT_RUNS_MAX_LIMIT);
    let from_ms = request.from_ms.unwrap_or_else(current_unix_ms);
    let policy_until = from_ms.saturating_add(default_search_horizon_ms(rule.horizon_freq));
    let searched_until_ms = request
        .search_until_ms
        .unwrap_or(policy_until)
        .min(policy_until);
    let result = rule
        .set
        .clone()
        .after(unix_ms_to_datetime(from_ms.saturating_add(1)))
        .before(unix_ms_to_datetime(searched_until_ms.saturating_add(1)))
        .all(limit as u16);
    let run_at_ms = result.dates.into_iter().map(datetime_to_unix_ms).collect();
    let continuation = if result.limited {
        ScheduleNextRunsContinuation::MoreAvailable
    } else if has_more_runs_after(rule, searched_until_ms) {
        ScheduleNextRunsContinuation::SearchLimitReached
    } else {
        ScheduleNextRunsContinuation::Exhausted
    };
    GetScheduleNextRunsRes {
        run_at_ms,
        searched_until_ms,
        continuation,
    }
}

fn next_schedule_checkpoint(now: u64, runs: &GetScheduleNextRunsRes) -> u64 {
    match runs.continuation {
        ScheduleNextRunsContinuation::MoreAvailable => {
            runs.run_at_ms.last().copied().unwrap_or(now)
        }
        ScheduleNextRunsContinuation::Exhausted
        | ScheduleNextRunsContinuation::SearchLimitReached => now,
    }
}

fn has_more_runs_after(rule: &ParsedRRuleSet, searched_until_ms: u64) -> bool {
    !rule
        .set
        .clone()
        .after(unix_ms_to_datetime(searched_until_ms.saturating_add(1)))
        .all(1)
        .dates
        .is_empty()
}

fn default_search_horizon_ms(freq: Frequency) -> u64 {
    let day = 24 * 60 * 60 * 1000;
    match freq {
        Frequency::Secondly => 60 * 60 * 1000,
        Frequency::Minutely => day,
        Frequency::Hourly => 30 * day,
        Frequency::Daily => 366 * day,
        Frequency::Weekly => 5 * 366 * day,
        Frequency::Monthly => 20 * 366 * day,
        Frequency::Yearly => 100 * 366 * day,
    }
}

fn unix_ms_to_datetime(ms: u64) -> DateTime<Tz> {
    let ms = ms.min(i64::MAX as u64) as i64;
    Tz::UTC
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Tz::UTC.timestamp_millis_opt(0).unwrap())
}

fn datetime_to_unix_ms(datetime: DateTime<Tz>) -> u64 {
    datetime.timestamp_millis().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgo_daemon_core::rpc::JobLogOptions;

    async fn wait_for_job_exit(manager: &CommandManager, job_id: &str) -> JobInfo {
        for _ in 0..100 {
            let snapshot = manager.jobs_snapshot(&SubscribeJobsReq::default()).await;
            if let Some(job) = snapshot
                .rows
                .into_iter()
                .find(|job| job.job_id == job_id && matches!(job.status, JobStatus::Exited { .. }))
            {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job did not exit in time");
    }

    fn output_test_launch() -> CommandLaunchSpec {
        if cfg!(windows) {
            CommandLaunchSpec {
                command: "cmd".to_string(),
                args: vec!["/C".to_string(), "echo final-output".to_string()],
                ..CommandLaunchSpec::default()
            }
        } else {
            CommandLaunchSpec {
                command: "sh".to_string(),
                args: vec!["-c".to_string(), "printf final-output".to_string()],
                ..CommandLaunchSpec::default()
            }
        }
    }

    fn stdin_blocking_test_launch() -> CommandLaunchSpec {
        if cfg!(windows) {
            CommandLaunchSpec {
                command: "ping".to_string(),
                args: vec!["-n".to_string(), "6".to_string(), "127.0.0.1".to_string()],
                ..CommandLaunchSpec::default()
            }
        } else {
            CommandLaunchSpec {
                command: "sleep".to_string(),
                args: vec!["5".to_string()],
                ..CommandLaunchSpec::default()
            }
        }
    }

    fn test_job_info(job_id: &str) -> JobInfo {
        JobInfo {
            job_id: job_id.to_string(),
            title: None,
            launch: CommandLaunchSpec {
                command: "test".to_string(),
                ..CommandLaunchSpec::default()
            },
            created_at_ms: 1,
            started_at_ms: Some(1),
            finished_at_ms: None,
            status: JobStatus::Running,
            reason: JobRunReason::Manual,
            log: JobLogState {
                stdout: JobOutputState {
                    enabled: true,
                    ..JobOutputState::default()
                },
                stderr: JobOutputState::default(),
            },
        }
    }

    #[tokio::test]
    async fn job_exit_waits_for_output_readers() {
        let manager = CommandManager::open(DaemonStateDb::open_in_memory_for_tests().unwrap())
            .expect("open command manager");
        let job = manager
            .create_job(CreateJobReq {
                launch: output_test_launch(),
                log: JobLogOptions {
                    stdout: true,
                    ..JobLogOptions::default()
                },
                ..CreateJobReq::default()
            })
            .await
            .expect("create job");

        wait_for_job_exit(&manager, &job.job_id).await;

        let (_, _, events) = manager
            .output_attached(&SubscribeJobOutputReq {
                job_id: job.job_id,
                stream: JobOutputStream::Stdout,
                after_seq: None,
            })
            .await
            .expect("attach job output");
        let stdout = events
            .into_iter()
            .filter_map(|event| match event {
                JobOutputEvent::Chunk { bytes, .. } => Some(bytes),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();

        assert!(
            String::from_utf8_lossy(&stdout).contains("final-output"),
            "stdout was {}",
            String::from_utf8_lossy(&stdout)
        );
    }

    #[tokio::test]
    async fn run_command_timeout_races_with_blocked_stdin_write() {
        let manager = CommandManager::open(DaemonStateDb::open_in_memory_for_tests().unwrap())
            .expect("open command manager");
        let started = std::time::Instant::now();

        let response = manager
            .run_command(RunCommandReq {
                launch: CommandLaunchSpec {
                    stdin: Some(CommandStdin::Bytes {
                        bytes: vec![b'x'; 2 * 1024 * 1024],
                    }),
                    ..stdin_blocking_test_launch()
                },
                timeout_ms: Some(50),
                ..RunCommandReq::default()
            })
            .await
            .expect("run command");

        assert_eq!(response.exit.reason, CommandExitReason::Timeout);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "timeout waited for blocked stdin write"
        );
    }

    #[tokio::test]
    async fn live_output_reports_retention_gap() {
        let manager = CommandManager::open(DaemonStateDb::open_in_memory_for_tests().unwrap())
            .expect("open command manager");
        let job = test_job_info("job-gap");
        {
            let mut state = manager.state.lock().await;
            state.jobs.insert(
                job.job_id.clone(),
                JobRecord {
                    info: job.clone(),
                    stdout: RetainedOutput::new(true, Some(1)),
                    stderr: RetainedOutput::new(false, None),
                    kill: None,
                },
            );
        }

        manager
            .append_output(&job.job_id, JobOutputStream::Stdout, b"a".to_vec())
            .await;
        manager
            .append_output(&job.job_id, JobOutputStream::Stdout, b"b".to_vec())
            .await;

        let (_, events) = manager
            .output_chunks_after(&job.job_id, JobOutputStream::Stdout, 1)
            .await
            .expect("read output chunks");

        assert!(matches!(
            events.as_slice(),
            [
                JobOutputEvent::HistoryGap { next_seq: 2 },
                JobOutputEvent::Chunk { seq: 2, bytes }
            ] if bytes == b"b"
        ));
    }

    #[tokio::test]
    async fn append_output_persists_only_retained_chunks() {
        let manager = CommandManager::open(DaemonStateDb::open_in_memory_for_tests().unwrap())
            .expect("open command manager");
        let job = test_job_info("job-evicted-output");
        manager.persist_job(&job).expect("persist job");
        {
            let mut state = manager.state.lock().await;
            state.jobs.insert(
                job.job_id.clone(),
                JobRecord {
                    info: job.clone(),
                    stdout: RetainedOutput::new(true, Some(1)),
                    stderr: RetainedOutput::new(false, None),
                    kill: None,
                },
            );
        }

        manager
            .append_output(&job.job_id, JobOutputStream::Stdout, b"too-large".to_vec())
            .await;

        let stored = manager
            .with_db(|db| db.load_job_output(&job.job_id, JobOutputStream::Stdout))
            .expect("load job output")
            .expect("stored output state");
        assert_eq!(stored.state.latest_seq, 1);
        assert_eq!(stored.state.oldest_seq, 0);
        assert!(stored.state.truncated);
        assert!(stored.chunks.is_empty());

        let (_, events) = manager
            .output_chunks_after(&job.job_id, JobOutputStream::Stdout, 0)
            .await
            .expect("read output chunks");
        assert!(matches!(
            events.as_slice(),
            [
                JobOutputEvent::HistoryGap { next_seq: 1 },
                JobOutputEvent::Truncated
            ]
        ));
    }

    #[tokio::test]
    async fn open_restores_persisted_output_chunks() {
        let db = DaemonStateDb::open_in_memory_for_tests().unwrap();
        let mut job = test_job_info("job-restored");
        job.status = JobStatus::Exited {
            exit: CommandExit {
                code: Some(0),
                signal: None,
                reason: CommandExitReason::ProcessExit,
                exited_at_ms: 2,
            },
        };
        job.finished_at_ms = Some(2);
        job.log.stdout = JobOutputState {
            enabled: true,
            oldest_seq: 1,
            latest_seq: 1,
            retained_bytes: 8,
            truncated: false,
        };
        db.save_job(&job).unwrap();
        db.save_job_output_state(&job.job_id, JobOutputStream::Stdout, &job.log.stdout)
            .unwrap();
        db.append_job_output_chunk(&job.job_id, JobOutputStream::Stdout, 1, b"restored", 2)
            .unwrap();

        let manager = CommandManager::open(db).expect("open command manager");
        let (_, state, events) = manager
            .output_attached(&SubscribeJobOutputReq {
                job_id: job.job_id,
                stream: JobOutputStream::Stdout,
                after_seq: None,
            })
            .await
            .expect("attach restored output");

        assert_eq!(state.latest_seq, 1);
        assert!(events.iter().any(|event| matches!(
            event,
            JobOutputEvent::Chunk { seq: 1, bytes } if bytes == b"restored"
        )));
    }

    fn ms(rfc3339: &str) -> u64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp_millis() as u64
    }

    fn next_runs(
        text: &str,
        limit: u64,
        from_ms: u64,
        search_until_ms: u64,
    ) -> GetScheduleNextRunsRes {
        let rule = parse_rrule_set(text).unwrap();
        next_runs_for_rule(
            &rule,
            GetScheduleNextRunsReq {
                schedule_id: "schedule-test".to_string(),
                limit,
                from_ms: Some(from_ms),
                search_until_ms: Some(search_until_ms),
            },
        )
    }

    #[test]
    fn rrule_next_runs_respect_rdate_and_exdate() {
        let result = next_runs(
            "DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY;COUNT=3\nRDATE:20260105T000000Z\nEXDATE:20260102T000000Z",
            10,
            ms("2025-12-31T00:00:00Z"),
            ms("2026-01-31T00:00:00Z"),
        );

        assert_eq!(
            result.run_at_ms,
            vec![
                ms("2026-01-01T00:00:00Z"),
                ms("2026-01-03T00:00:00Z"),
                ms("2026-01-05T00:00:00Z"),
            ]
        );
        assert_eq!(result.continuation, ScheduleNextRunsContinuation::Exhausted);
    }

    #[test]
    fn rrule_next_runs_support_byday_rules() {
        let result = next_runs(
            "DTSTART:20260101T000000Z\nRRULE:FREQ=MONTHLY;COUNT=2;BYDAY=MO;BYSETPOS=1",
            10,
            ms("2025-12-31T00:00:00Z"),
            ms("2026-03-31T00:00:00Z"),
        );

        assert_eq!(
            result.run_at_ms,
            vec![ms("2026-01-05T00:00:00Z"), ms("2026-02-02T00:00:00Z"),]
        );
        assert_eq!(result.continuation, ScheduleNextRunsContinuation::Exhausted);
    }

    #[test]
    fn rrule_next_runs_reports_more_when_limit_is_reached() {
        let result = next_runs(
            "DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY",
            2,
            ms("2025-12-31T00:00:00Z"),
            ms("2026-01-31T00:00:00Z"),
        );

        assert_eq!(result.run_at_ms.len(), 2);
        assert_eq!(
            result.continuation,
            ScheduleNextRunsContinuation::MoreAvailable
        );
    }

    #[test]
    fn rrule_next_runs_continuation_starts_after_last_returned_run() {
        let first = next_runs(
            "DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY",
            1,
            ms("2025-12-31T00:00:00Z"),
            ms("2026-01-31T00:00:00Z"),
        );
        assert_eq!(first.run_at_ms, vec![ms("2026-01-01T00:00:00Z")]);
        assert_eq!(
            first.continuation,
            ScheduleNextRunsContinuation::MoreAvailable
        );

        let second = next_runs(
            "DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY",
            1,
            first.run_at_ms[0],
            ms("2026-01-31T00:00:00Z"),
        );
        assert_eq!(second.run_at_ms, vec![ms("2026-01-02T00:00:00Z")]);
    }

    #[test]
    fn schedule_checkpoint_preserves_unprocessed_due_runs() {
        let first = ms("2026-01-01T00:00:00Z");
        let second = ms("2026-01-02T00:00:00Z");
        let now = ms("2026-01-31T00:00:00Z");
        let limited = GetScheduleNextRunsRes {
            run_at_ms: vec![first, second],
            searched_until_ms: now,
            continuation: ScheduleNextRunsContinuation::MoreAvailable,
        };

        assert_eq!(next_schedule_checkpoint(now, &limited), second);

        let exhausted = GetScheduleNextRunsRes {
            run_at_ms: vec![first, second],
            searched_until_ms: now,
            continuation: ScheduleNextRunsContinuation::Exhausted,
        };

        assert_eq!(next_schedule_checkpoint(now, &exhausted), now);
    }
}
