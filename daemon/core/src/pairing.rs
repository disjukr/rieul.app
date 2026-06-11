use base64::prelude::*;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::config::{ClientCredentialRecord, PairingRecord};

pub const PAIRING_CODE_DIGITS: usize = 6;
pub const PAIRING_TTL_SECONDS: i64 = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingCode {
    pub code: String,
    pub record: PairingRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedClientSecret {
    pub client_id: String,
    pub client_secret: String,
    pub record: ClientCredentialRecord,
}

pub fn create_pairing_code(now_unix: i64) -> PairingCode {
    let mut rng = rand::rng();
    let n = (rng.next_u32() % 1_000_000) as usize;
    let code = format!("{n:0width$}", width = PAIRING_CODE_DIGITS);
    PairingCode {
        record: PairingRecord {
            code_sha256_base64url: sha256_base64url(code.as_bytes()),
            expires_at_unix: now_unix + PAIRING_TTL_SECONDS,
        },
        code,
    }
}

pub fn verify_pairing_code(record: &PairingRecord, code: &str, now_unix: i64) -> bool {
    if now_unix >= record.expires_at_unix {
        return false;
    }
    constant_time_eq(
        record.code_sha256_base64url.as_bytes(),
        sha256_base64url(code.as_bytes()).as_bytes(),
    )
}

pub fn issue_client_secret(label: impl Into<String>, now_unix: i64) -> IssuedClientSecret {
    let client_id = random_base64url(16);
    let client_secret = random_base64url(32);
    IssuedClientSecret {
        record: ClientCredentialRecord {
            client_id: client_id.clone(),
            label: label.into(),
            secret_sha256_base64url: sha256_base64url(client_secret.as_bytes()),
            created_at_unix: now_unix,
        },
        client_id,
        client_secret,
    }
}

pub fn verify_client_secret(record: &ClientCredentialRecord, presented: &str) -> bool {
    constant_time_eq(
        record.secret_sha256_base64url.as_bytes(),
        sha256_base64url(presented.as_bytes()).as_bytes(),
    )
}

pub fn sha256_base64url(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    BASE64_URL_SAFE_NO_PAD.encode(hash)
}

fn random_base64url(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    rand::rng().fill_bytes(&mut bytes);
    BASE64_URL_SAFE_NO_PAD.encode(bytes)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in a.iter().zip(b) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_code_expires() {
        let pairing = create_pairing_code(100);
        assert_eq!(pairing.record.expires_at_unix, 400);
        assert!(verify_pairing_code(&pairing.record, &pairing.code, 101));
        assert!(!verify_pairing_code(&pairing.record, &pairing.code, 400));
        assert!(!verify_pairing_code(&pairing.record, "000000", 101));
    }

    #[test]
    fn client_secret_verification() {
        let issued = issue_client_secret("browser", 100);
        assert!(verify_client_secret(&issued.record, &issued.client_secret));
        assert!(!verify_client_secret(&issued.record, "wrong"));
    }
}
