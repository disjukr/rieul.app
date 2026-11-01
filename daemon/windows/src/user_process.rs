use anyhow::Result;
use rieul_daemon_core::config::profile_id_for_config_path;
use std::path::PathBuf;

pub fn run_user_process(config_path: PathBuf) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let profile=profile_id_for_config_path(config_path);
    runtime.block_on(async move {
        #[cfg(windows)] {
            let desktop_profile=profile.clone();
            tokio::spawn(async move {
                if let Err(error)=crate::desktop_ipc::run(desktop_profile).await {
                    tracing::warn!(?error,"desktop IPC retired; terminal service remains available");
                }
            });
        }
        crate::ipc::run_user_ipc_server(profile).await
    })
}
