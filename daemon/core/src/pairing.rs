use base64::prelude::*;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::config::ClientCredentialRecord;

pub const PAIRING_CODE_DIGITS: usize = 6;
pub const PAIRING_TTL_SECONDS: i64 = 180;
pub const CLIENT_CREDENTIAL_TTL_SECONDS: i64 = 60 * 60 * 24 * 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingCode {
    pub code: String,
    pub record: PairingRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingRecord {
    pub code_sha256_base64url: String,
    pub expires_at_unix: i64,
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
    issue_client_secret_for_client_id(client_id, label, now_unix, now_unix)
}

pub fn reissue_client_secret(
    record: &ClientCredentialRecord,
    label: impl Into<String>,
    now_unix: i64,
) -> IssuedClientSecret {
    issue_client_secret_for_client_id(
        record.client_id.clone(),
        label,
        record.created_at_unix,
        now_unix,
    )
}

fn issue_client_secret_for_client_id(
    client_id: String,
    label: impl Into<String>,
    created_at_unix: i64,
    now_unix: i64,
) -> IssuedClientSecret {
    let client_secret = random_base64url(32);
    IssuedClientSecret {
        record: ClientCredentialRecord {
            client_id: client_id.clone(),
            label: label.into(),
            secret_sha256_base64url: sha256_base64url(client_secret.as_bytes()),
            created_at_unix,
            expires_at_unix: client_credential_expires_at(now_unix),
        },
        client_id,
        client_secret,
    }
}

pub fn renew_client_credential(record: &mut ClientCredentialRecord, now_unix: i64) {
    record.expires_at_unix = client_credential_expires_at(now_unix);
}

pub fn verify_client_credential(
    record: &ClientCredentialRecord,
    presented: &str,
    now_unix: i64,
) -> bool {
    now_unix < record.expires_at_unix && verify_client_secret(record, presented)
}

pub fn verify_client_secret(record: &ClientCredentialRecord, presented: &str) -> bool {
    constant_time_eq(
        record.secret_sha256_base64url.as_bytes(),
        sha256_base64url(presented.as_bytes()).as_bytes(),
    )
}

fn client_credential_expires_at(now_unix: i64) -> i64 {
    now_unix + CLIENT_CREDENTIAL_TTL_SECONDS
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
        assert_eq!(pairing.record.expires_at_unix, 280);
        assert!(verify_pairing_code(&pairing.record, &pairing.code, 101));
        assert!(!verify_pairing_code(&pairing.record, &pairing.code, 280));
        assert!(!verify_pairing_code(&pairing.record, "000000", 101));
    }

    #[test]
    fn client_secret_verification() {
        let issued = issue_client_secret("browser", 100);
        assert_eq!(
            issued.record.expires_at_unix,
            100 + CLIENT_CREDENTIAL_TTL_SECONDS
        );
        assert!(verify_client_credential(
            &issued.record,
            &issued.client_secret,
            101
        ));
        assert!(!verify_client_credential(
            &issued.record,
            &issued.client_secret,
            issued.record.expires_at_unix
        ));
        assert!(verify_client_secret(&issued.record, &issued.client_secret));
        assert!(!verify_client_secret(&issued.record, "wrong"));
    }

    #[test]
    fn client_secret_can_be_reissued_for_existing_client_id() {
        let original = issue_client_secret("browser", 100);
        let reissued = reissue_client_secret(&original.record, "browser", 200);

        assert_eq!(reissued.client_id, original.client_id);
        assert_eq!(reissued.record.client_id, original.client_id);
        assert_eq!(reissued.record.label, "browser");
        assert_eq!(reissued.record.created_at_unix, 100);
        assert_eq!(
            reissued.record.expires_at_unix,
            200 + CLIENT_CREDENTIAL_TTL_SECONDS
        );
        assert!(verify_client_secret(
            &reissued.record,
            &reissued.client_secret
        ));
        assert!(!verify_client_secret(
            &reissued.record,
            &original.client_secret
        ));
    }

    #[test]
    fn client_credential_can_be_renewed() {
        let mut issued = issue_client_secret("browser", 100).record;

        renew_client_credential(&mut issued, 200);

        assert_eq!(issued.expires_at_unix, 200 + CLIENT_CREDENTIAL_TTL_SECONDS);
    }
}
