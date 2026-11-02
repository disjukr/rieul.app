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
                loop {
                    if let Err(error)=crate::desktop_ipc::run(desktop_profile.clone()).await {
                        tracing::warn!(?error,"desktop IPC retired; starting an empty helper after cleanup");
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            });
        }
        crate::ipc::run_user_ipc_server(profile).await
    })
}
