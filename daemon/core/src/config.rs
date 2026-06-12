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
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            listen_addr: default_listen_addr(),
            domain: None,
            tls: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingState {
    #[serde(default)]
    pub clients: Vec<ClientCredentialRecord>,
    #[serde(default)]
    pub pairing: Option<PairingRecord>,
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

pub fn pairing_state_path(config_path: impl AsRef<Path>) -> PathBuf {
    config_path.as_ref().with_file_name("pairing.yaml")
}

pub fn load_pairing_state_or_default(path: impl AsRef<Path>) -> Result<PairingState, ConfigError> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(PairingState::default());
    }
    let yaml = fs::read_to_string(path)?;
    Ok(serde_yaml::from_str(&yaml)?)
}

pub fn save_pairing_state(
    path: impl AsRef<Path>,
    pairing_state: &PairingState,
) -> Result<(), ConfigError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let yaml = serde_yaml::to_string(pairing_state)?;
    fs::write(path, yaml)?;
    Ok(())
}

pub fn windows_program_data_config_path() -> PathBuf {
    let root = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    root.join("wgo").join("wgo.yaml")
}

pub fn macos_system_config_path() -> PathBuf {
    PathBuf::from("/Library")
        .join("Application Support")
        .join("wgo")
        .join("wgo.yaml")
}

pub fn macos_user_config_path() -> PathBuf {
    let root = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    root.join("Library")
        .join("Application Support")
        .join("wgo")
        .join("wgo-user.yaml")
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
        };
        save(&path, &config).unwrap();
        assert_eq!(load_or_default(&path).unwrap(), config);
    }

    #[test]
    fn pairing_state_roundtrip_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("wgo.yaml");
        let path = pairing_state_path(&config_path);
        let state = PairingState {
            clients: vec![ClientCredentialRecord {
                client_id: "client".to_string(),
                label: "browser".to_string(),
                secret_sha256_base64url: "hash".to_string(),
                created_at_unix: 100,
            }],
            pairing: Some(PairingRecord {
                code_sha256_base64url: "code".to_string(),
                expires_at_unix: 400,
            }),
        };

        save_pairing_state(&path, &state).unwrap();

        assert_eq!(load_pairing_state_or_default(&path).unwrap(), state);
    }
}
