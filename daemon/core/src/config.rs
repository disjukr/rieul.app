use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::DEFAULT_LISTEN_ADDR;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("yaml error: {0}")]
    Yaml(#[from] serde_yaml::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemConfig {
    #[serde(default = "default_listen_addr")]
    pub listen_addr: String,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub tls: Option<TlsConfig>,
    #[serde(default)]
    pub clients: Vec<ClientCredentialRecord>,
    #[serde(default)]
    pub pairing: Option<PairingRecord>,
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            listen_addr: default_listen_addr(),
            domain: None,
            tls: None,
            clients: Vec::new(),
            pairing: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TlsConfig {
    pub cert_file: String,
    pub key_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientCredentialRecord {
    pub client_id: String,
    pub label: String,
    pub secret_sha256_base64url: String,
    pub created_at_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingRecord {
    pub code_sha256_base64url: String,
    pub expires_at_unix: i64,
}

fn default_listen_addr() -> String {
    DEFAULT_LISTEN_ADDR.to_string()
}

pub fn load_or_default(path: impl AsRef<Path>) -> Result<SystemConfig, ConfigError> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(SystemConfig::default());
    }
    let yaml = fs::read_to_string(path)?;
    Ok(serde_yaml::from_str(&yaml)?)
}

pub fn save(path: impl AsRef<Path>, config: &SystemConfig) -> Result<(), ConfigError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let yaml = serde_yaml::to_string(config)?;
    fs::write(path, yaml)?;
    Ok(())
}

pub fn windows_program_data_config_path() -> PathBuf {
    let root = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    root.join("wgo").join("wgo.yaml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roundtrip_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wgo.yaml");
        let config = SystemConfig {
            listen_addr: "0.0.0.0:8765".to_string(),
            domain: Some("pc.example.com".to_string()),
            tls: Some(TlsConfig {
                cert_file: r"C:\wgo\cert.pem".to_string(),
                key_file: r"C:\wgo\key.pem".to_string(),
            }),
            clients: Vec::new(),
            pairing: None,
        };
        save(&path, &config).unwrap();
        assert_eq!(load_or_default(&path).unwrap(), config);
    }
}
