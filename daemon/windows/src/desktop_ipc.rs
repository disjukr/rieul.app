//! Dedicated desktop pipe; terminal/user process startup remains independent.
use rieul_daemon_host::{
    desktop::{Backend, Error},
    desktop_ipc::{Connection, Proxy},
};
use std::{os::windows::io::AsRawHandle, path::Path, sync::Arc};
use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            Pipes::GetNamedPipeServerProcessId,
            Threading::{
                OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                QueryFullProcessImageNameW,
            },
        },
    },
    core::PWSTR,
};
fn pipe_name(profile: &str, session: u32) -> String {
    format!(r"\\.\pipe\rieul-desktop-profile-{profile}-session-{session}")
}
fn valid_profile(profile: &str) -> bool {
    !profile.is_empty()
        && profile.len() <= 128
        && profile
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn verify_server(handle: std::os::windows::io::RawHandle, session: u32) -> Result<(), Error> {
    crate::terminal_ipc::verify_user_pipe_server_handle(handle, session)
        .map_err(|_| Error::Unauthorized)?;
    let mut pid = 0;
    unsafe { GetNamedPipeServerProcessId(HANDLE(handle), &mut pid) }
        .map_err(|_| Error::Unauthorized)?;
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|_| Error::Unauthorized)?;
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    unsafe {
        let _ = CloseHandle(process);
    }
    result.map_err(|_| Error::Unauthorized)?;
    let path = std::path::PathBuf::from(
        String::from_utf16(&buffer[..length as usize]).map_err(|_| Error::Unauthorized)?,
    )
    .canonicalize()
    .map_err(|_| Error::Unauthorized)?;
    let expected = std::env::current_exe()
        .map_err(|_| Error::Unauthorized)?
        .with_file_name("rieul-windows-user.exe")
        .canonicalize()
        .map_err(|_| Error::Unauthorized)?;
    if path != expected {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
pub fn proxy(config: &Path) -> Arc<dyn Backend> {
    let profile = rieul_daemon_core::config::profile_id_for_config_path(config);
    let login = Arc::new(std::sync::Mutex::new(None));
    Arc::new(Proxy::new(Arc::new(move || {
        let login = login.clone();
        let profile = profile.clone();
        Box::pin(async move {
            if !valid_profile(&profile) {
                return Err(Error::Invalid);
            }
            let session = crate::terminal_ipc::active_console_session_id()
                .map_err(|_| Error::Unauthorized)?;
            { let mut bound = login.lock().map_err(|_| Error::Backend)?;
              if bound.is_some_and(|previous| previous != session) { return Err(Error::Unauthorized); }
              *bound = Some(session); }
            let pipe = ClientOptions::new()
                .open(pipe_name(&profile, session))
                .map_err(|_| Error::Unsupported)?;
            verify_server(pipe.as_raw_handle(), session)?;
            if crate::terminal_ipc::active_console_session_id().map_err(|_| Error::Unauthorized)?
                != session
            {
                return Err(Error::Stale);
            }
            Ok(Box::new(pipe) as Connection)
        })
    })))
}
pub async fn run(profile: String) -> anyhow::Result<()> {
    anyhow::ensure!(valid_profile(&profile), "invalid desktop profile");
    let session = crate::terminal_ipc::current_process_session_id()?;
    anyhow::ensure!(session != 0, "desktop helper cannot run in session zero");
    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .max_instances(1)
        .reject_remote_clients(true)
        .create(pipe_name(&profile, session))?;
    loop {
        server.connect().await?;
        if crate::terminal_ipc::verify_user_pipe_client(&server).is_err()
            || !crate::desktop_native::interactive()
        {
            server.disconnect()?;
            continue;
        }
        let backend = Arc::new(
            crate::desktop::WindowsDesktop::for_user_session()
                .map_err(|e| anyhow::anyhow!("desktop backend: {e:?}"))?,
        );
        let result = rieul_daemon_host::desktop_ipc::serve(server, backend).await;
        return Err(anyhow::anyhow!("desktop IPC ended: {result:?}"));
    }
}
