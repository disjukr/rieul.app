use anyhow::Result;
use rieul_daemon_core::config::profile_id_for_config_path;
use std::path::PathBuf;

pub fn run_user_process(config_path: PathBuf) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()?;
    runtime.block_on(crate::ipc::run_user_ipc_server(profile_id_for_config_path(
        config_path,
    )))
}
