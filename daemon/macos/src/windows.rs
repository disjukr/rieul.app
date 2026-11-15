//! Read-only window metadata on the existing authenticated desktop channel.
//! No root WindowServer access, capture, AX calls, or permission requests.
use rieul_daemon_core::{
    generated::rpc::{WindowBounds, WindowDetail, WindowInfo, WindowState},
    traits::{BoxFutureResult, ServiceError, WindowService},
};
use rieul_daemon_host::desktop::{Backend, Error, MAX_WINDOW_ROWS, MAX_WINDOW_TITLE_BYTES};
use std::{sync::{Arc, Mutex}, time::{Duration, Instant}};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ConsoleSession { uid: u32, changed: i64, nanos: i64 }
#[cfg(target_os = "macos")]
fn console_session() -> Result<ConsoleSession, Error> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata("/dev/console").map_err(|_| Error::Unauthorized)?;
    if metadata.uid() == 0 { return Err(Error::Unauthorized); }
    Ok(ConsoleSession { uid: metadata.uid(), changed: metadata.ctime(), nanos: metadata.ctime_nsec() })
}

#[cfg(not(target_os = "macos"))]
fn console_session() -> Result<ConsoleSession, Error> { Err(Error::Unsupported) }

/// Once a desktop transition is observed, old IDs and cached snapshots cannot
/// become valid again, even if the same UID returns to the console.
#[derive(Default)]
struct SessionFence { bound: Option<ConsoleSession>, retired: bool }
impl SessionFence {
    fn check(&mut self, current: Result<ConsoleSession, Error>) -> Result<(), Error> {
        if self.retired { return Err(Error::Stale); }
        match current {
            Ok(current) if self.bound.is_none_or(|old| old == current) => {
                self.bound = Some(current);
                Ok(())
            }
            _ => { self.retired = true; Err(Error::Stale) }
        }
    }
}

pub struct MacWindowService {
    backend: Arc<dyn Backend>,
    session: Mutex<SessionFence>,
    session_source: Arc<dyn Fn() -> Result<ConsoleSession, Error> + Send + Sync>,
    cache: tokio::sync::Mutex<Option<(Instant, u64, Result<Vec<WindowDetail>, Error>)>>,
}
impl MacWindowService {
    pub fn new(backend: Arc<dyn Backend>) -> Self {
        Self { backend, session: Mutex::new(SessionFence::default()), session_source: Arc::new(console_session), cache: Default::default() }
    }
    fn check_session(&self) -> Result<(), Error> {
        self.session.lock().map_err(|_| Error::Backend)?.check((self.session_source)())
    }
}
fn service_error(error: Error) -> ServiceError {
    match error {
        Error::Unauthorized | Error::HelperAuthentication => ServiceError::PermissionDenied,
        Error::Unsupported => ServiceError::Unsupported,
        _ => ServiceError::OperationFailed(format!("window metadata unavailable: {error:?}")),
    }
}
impl WindowService for MacWindowService {
    fn windows(&self) -> BoxFutureResult<'_, Vec<WindowDetail>> {
        Box::pin(async move {
            self.check_session().map_err(service_error)?;
            // Coalesce list and all detail subscribers, including failures. The
            // mutex is async: a slow native query cannot block the runtime.
            let mut cache = self.cache.lock().await;
            self.check_session().map_err(service_error)?;
            let generation = self.backend.generation();
            if let Some((at, previous, rows)) = &*cache {
                if *previous == generation && at.elapsed() < Duration::from_secs(1) {
                    let rows = rows.clone();
                    self.check_session().map_err(service_error)?;
                    if self.backend.generation() != generation { return Err(service_error(Error::Stale)); }
                    return rows.map_err(service_error);
                }
            }
            let backend = self.backend.clone();
            let rows = tokio::task::spawn_blocking(move || backend.window_snapshot()).await
                .map_err(|_| ServiceError::OperationFailed("window metadata worker failed".into()))?;
            self.check_session().map_err(service_error)?;
            // Any channel invalidation discards an in-flight result, including
            // the initial generation (zero).
            let after = self.backend.generation();
            if generation != after { return Err(service_error(Error::Stale)); }
            *cache = Some((Instant::now(), after, rows.clone()));
            rows.map_err(service_error)
        })
    }
}

#[derive(serde::Deserialize)]
struct NativeWindow {
    id: u32, pid: u32, title: Option<String>, visible: Option<bool>,
    x: i64, y: i64, width: u64, height: u64,
}
fn decode_snapshot(bytes: &[u8], epoch: &str) -> Result<Vec<WindowDetail>, Error> {
    let rows: Vec<NativeWindow> = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
    if rows.len() > MAX_WINDOW_ROWS { return Err(Error::Limit); }
    let mut seen = std::collections::BTreeSet::new();
    rows.into_iter().map(|w| {
        if w.id == 0 || w.pid == 0 || w.pid > i32::MAX as u32 || w.width == 0 || w.height == 0 ||
            w.x.unsigned_abs() > (1 << 53)-1 || w.y.unsigned_abs() > (1 << 53)-1 ||
            w.width > (1 << 53)-1 || w.height > (1 << 53)-1 || !seen.insert(w.id) ||
            w.title.as_ref().is_some_and(|s| s.len() > MAX_WINDOW_TITLE_BYTES) {
            return Err(Error::Invalid);
        }
        Ok(WindowDetail {
            info: WindowInfo { window_id: format!("mac-{epoch}-{}-{}", w.id, w.pid),
                title: w.title.filter(|s| !s.is_empty()), process_id: Some(w.pid as u64), focused: None },
            state: WindowState { visible: w.visible, minimized: None, maximized: None },
            bounds: Some(WindowBounds { x:w.x, y:w.y, width:w.width, height:w.height }),
        })
    }).collect()
}

#[cfg(target_os = "macos")]
pub(crate) struct NativeWindows { epoch: String, session: Mutex<SessionFence> }
#[cfg(target_os = "macos")]
impl NativeWindows {
    pub fn new() -> Result<Self, Error> {
        use std::io::Read;
        let mut bytes = [0u8; 16];
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).map_err(|_| Error::Backend)?;
        let mut session = SessionFence::default();
        session.check(console_session())?;
        Ok(Self { epoch: bytes.iter().map(|b| format!("{b:02x}")).collect(), session: Mutex::new(session) })
    }
    fn check(&self) -> Result<(), Error> {
        unsafe extern "C" { fn rd_windows_session_active() -> bool; }
        let current = console_session().and_then(|s| {
            if s.uid == unsafe { libc::geteuid() } && unsafe { rd_windows_session_active() } { Ok(s) }
            else { Err(Error::Unauthorized) }
        });
        self.session.lock().map_err(|_| Error::Backend)?.check(current)
    }
    pub fn snapshot(&self) -> Result<Vec<WindowDetail>, Error> {
        unsafe extern "C" { fn rd_windows_snapshot(output: *mut u8, capacity: usize) -> usize; }
        self.check()?;
        let mut bytes = vec![0u8; 512 * 1024];
        let size = unsafe { rd_windows_snapshot(bytes.as_mut_ptr(), bytes.len()) };
        self.check()?;
        if size == 0 || size > bytes.len() { return Err(Error::Backend); }
        decode_snapshot(&bytes[..size], &self.epoch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_keeps_titleless_offscreen_and_unknown_states() {
        let bytes = br#"[{"id":42,"pid":99,"x":-12,"y":4,"width":800,"height":600,"visible":false}]"#;
        let a = decode_snapshot(bytes, "a").unwrap();
        let b = decode_snapshot(bytes, "b").unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].info.title, None);
        assert_eq!(a[0].info.process_id, Some(99));
        assert_eq!(a[0].info.focused, None);
        assert_eq!(a[0].state.visible, Some(false));
        assert_eq!(a[0].state.minimized, None);
        assert_eq!(a[0].state.maximized, None);
        assert_eq!(a[0].bounds.as_ref().unwrap().x, -12);
        assert_ne!(a[0].info.window_id, b[0].info.window_id);
    }
    #[test]
    fn invalid_or_oversized_snapshots_are_not_empty_tables() {
        let row = serde_json::json!({"id":42,"pid":99,"x":0,"y":0,"width":1,"height":1});
        for rows in [vec![row.clone(),row.clone()], vec![row.clone(); MAX_WINDOW_ROWS+1]] {
            assert!(decode_snapshot(&serde_json::to_vec(&rows).unwrap(), "a").is_err());
        }
        for (key,value) in [("id",serde_json::json!(0)),("pid",serde_json::json!(0)),("title",serde_json::json!("x".repeat(513))),("width",serde_json::json!(9007199254740992u64))] {
            let mut bad=row.clone(); bad[key]=value;
            assert!(decode_snapshot(&serde_json::to_vec(&vec![bad]).unwrap(),"a").is_err());
        }
        assert!(decode_snapshot(b"null", "a").is_err());
        assert!(decode_snapshot(b"[]", "a").unwrap().is_empty());
    }
    #[test]
    fn session_transition_permanently_retires_old_metadata() {
        let a=ConsoleSession { uid:501, changed:1, nanos:1 };
        for b in [ConsoleSession{uid:502,..a},ConsoleSession{changed:2,..a},ConsoleSession{nanos:2,..a}] {
            let mut gate=SessionFence::default();
            assert!(gate.check(Ok(a)).is_ok());
            assert!(gate.check(Ok(a)).is_ok());
            assert_eq!(gate.check(Ok(b)),Err(Error::Stale));
            assert_eq!(gate.check(Ok(a)),Err(Error::Stale));
        }
        let mut gate=SessionFence::default();
        gate.check(Ok(a)).unwrap();
        assert_eq!(gate.check(Err(Error::Unauthorized)),Err(Error::Stale));
        assert_eq!(gate.check(Ok(a)),Err(Error::Stale));
    }
    struct FakeWindows { calls: std::sync::atomic::AtomicUsize, fail: bool }
    impl Backend for FakeWindows {
        fn capabilities(&self) -> rieul_daemon_core::generated::rpc::DesktopCapabilities { Default::default() }
        fn displays(&self) -> Vec<rieul_daemon_core::generated::rpc::DesktopDisplay> { vec![] }
        fn input(&self, _: &rieul_daemon_core::generated::rpc::DesktopInputEvent) -> Result<(), Error> { panic!("metadata must not inject input") }
        fn window_snapshot(&self) -> Result<Vec<WindowDetail>, Error> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(20));
            if self.fail { Err(Error::Unsupported) } else { Ok(vec![]) }
        }
    }
    #[tokio::test]
    async fn subscribers_share_one_snapshot_and_failures_are_coalesced() {
        for fail in [false, true] {
            let backend = Arc::new(FakeWindows { calls: Default::default(), fail });
            let mut service = MacWindowService::new(backend.clone());
            service.session_source = Arc::new(|| Ok(ConsoleSession { uid:501, changed:1, nanos:0 }));
            let service=Arc::new(service);
            let mut requests=tokio::task::JoinSet::new();
            for _ in 0..20 {
                let service=service.clone();
                requests.spawn(async move { service.windows().await });
            }
            while let Some(result)=requests.join_next().await { assert_eq!(result.unwrap().is_err(), fail); }
            assert_eq!(backend.calls.load(std::sync::atomic::Ordering::SeqCst),1);
        }
    }
    #[tokio::test]
    async fn transition_during_read_discards_result_and_cached_data_never_crosses_sessions() {
        use std::sync::atomic::{AtomicU64,Ordering};
        let backend = Arc::new(FakeWindows { calls: Default::default(), fail:false });
        let session=Arc::new(AtomicU64::new(1));
        let source=session.clone();
        let mut service=MacWindowService::new(backend.clone());
        service.session_source=Arc::new(move || Ok(ConsoleSession { uid:501, changed:source.load(Ordering::SeqCst) as i64, nanos:0 }));
        let service=Arc::new(service);
        let call=service.clone();
        let pending=tokio::spawn(async move { call.windows().await });
        while backend.calls.load(Ordering::SeqCst)==0 { tokio::task::yield_now().await; }
        session.store(2,Ordering::SeqCst);
        assert!(pending.await.unwrap().is_err());
        session.store(1,Ordering::SeqCst);
        assert!(service.windows().await.is_err());
        assert_eq!(backend.calls.load(Ordering::SeqCst),1);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn synthetic_native_metadata_conversion() {
        unsafe extern "C" { fn rd_test_window_metadata() -> bool; }
        assert!(unsafe { rd_test_window_metadata() });
    }
}
