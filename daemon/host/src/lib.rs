pub mod agent;
pub mod agent_runtime;
pub mod cert;
pub mod command;
pub mod server;
pub mod state_db;
pub mod terminal;

mod db_schema;
mod shell_integration;

pub mod maintenance;

pub mod updates;

pub mod desktop;

pub mod desktop_ipc;

// Unregistered, fixture-only foundations pending membership policy review.
#[cfg(test)]
mod cluster;
