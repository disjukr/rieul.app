use anyhow::Result;

pub fn run_window_agent() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()?;
    runtime.block_on(crate::ipc::run_window_snapshot_server())
}
