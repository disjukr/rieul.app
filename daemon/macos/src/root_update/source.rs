//! All origins and filenames are compiled in; release JSON supplies only a tag.
use super::{archive::MAX_ARCHIVE, store::Dir, Version};
use anyhow::{ensure, Result};
use reqwest::{blocking::Client, redirect::Policy};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    time::Duration,
};
const RELEASE: &str = "https://api.github.com/repos/disjukr/rieul.app/releases/latest";
const PREFIX: &str = "desktop-";
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}
fn allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
}
fn client() -> Result<Client> {
    Ok(Client::builder()
        .https_only(true)
        .no_proxy()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .user_agent("rieul-macos-root-updater/1")
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() < 5 && allowed(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("unapproved redirect")
            }
        }))
        .build()?)
}
fn release_version(bytes: &[u8]) -> Result<Version> {
    let release: Release = serde_json::from_slice(bytes)?;
    ensure!(
        !release.draft && !release.prerelease,
        "release is not stable"
    );
    Version::parse(
        release
            .tag_name
            .strip_prefix(PREFIX)
            .ok_or_else(|| anyhow::anyhow!("unexpected release tag"))?,
    )
}
fn artifact(version: Version) -> String {
    format!(
        "https://github.com/disjukr/rieul.app/releases/download/desktop-{}/rieul-macos-update.tar",
        version.text()
    )
}
pub(super) fn latest() -> Result<Version> {
    let mut bytes = Vec::new();
    client()?
        .get(RELEASE)
        .send()?
        .error_for_status()?
        .take(65537)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "release metadata too large");
    release_version(&bytes)
}
pub(super) fn download(version: Version, stage: &Dir) -> Result<()> {
    let response = client()?
        .get(artifact(version))
        .send()?
        .error_for_status()?;
    ensure!(
        response.content_length().is_none_or(|n| n <= MAX_ARCHIVE),
        "archive too large"
    );
    let mut out = stage.create("candidate.tar", 0o600)?;
    let count = std::io::copy(&mut response.take(MAX_ARCHIVE + 1), &mut out)?;
    ensure!(count <= MAX_ARCHIVE, "archive too large");
    out.flush()?;
    out.sync_all()?;
    stage.sync()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_tag_influences_source() {
        let version=release_version(br#"{"tag_name":"desktop-0.6.12","draft":false,"prerelease":false,"assets":[{"browser_download_url":"https://evil.test/root"}]}"#).unwrap();
        assert_eq!(artifact(version),"https://github.com/disjukr/rieul.app/releases/download/desktop-0.6.12/rieul-macos-update.tar");
        for tag in [
            "desktop-../evil",
            "desktop-1.2.3/evil",
            "desktop-01.2.3",
            "desktop-1.2.3-rc1",
        ] {
            let bytes = serde_json::to_vec(
                &serde_json::json!({"tag_name":tag,"draft":false,"prerelease":false}),
            )
            .unwrap();
            assert!(release_version(&bytes).is_err());
        }
    }
    #[test]
    fn redirects_cannot_escape_origins() {
        for url in [
            "http://github.com/a",
            "https://github.com.evil.test/a",
            "https://evil.test/a",
            "https://user@github.com/a",
            "https://github.com:444/a",
        ] {
            assert!(!allowed(&url.parse().unwrap()));
        }
        assert!(allowed(
            &"https://release-assets.githubusercontent.com/a?token=x"
                .parse()
                .unwrap()
        ));
    }
}
