pub mod cbor;
pub mod config;
pub mod generated;
pub mod ipc;
pub mod pairing;
pub mod rpc;
pub mod socket_wire;
pub mod traits;
pub mod wire;

pub const PRODUCT_NAME: &str = "rieul";
pub const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:9012";

pub mod desktop_transport;

pub mod local_update;

pub mod desktop_stripe;

pub mod desktop_hevc;
