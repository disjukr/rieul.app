//! Inspect staged bytes; never execute an update candidate to identify its CPU.
use anyhow::{ensure, Result};
use std::{fs::File, io::Read};

pub(crate) fn audit_macho(file: File) -> Result<bool> {
    let mut prefix = Vec::new();
    file.take(8).read_to_end(&mut prefix)?;
    audit_prefix(&prefix)
}

fn audit_prefix(prefix: &[u8]) -> Result<bool> {
    let Some(magic) = prefix.get(..4) else {
        return Ok(false);
    };
    let macho = matches!(
        magic,
        [0xce, 0xfa, 0xed, 0xfe]
            | [0xfe, 0xed, 0xfa, 0xce]
            | [0xcf, 0xfa, 0xed, 0xfe]
            | [0xfe, 0xed, 0xfa, 0xcf]
            | [0xca, 0xfe, 0xba, 0xbe]
            | [0xbe, 0xba, 0xfe, 0xca]
            | [0xca, 0xfe, 0xba, 0xbf]
            | [0xbf, 0xba, 0xfe, 0xca]
    );
    if !macho {
        return Ok(false);
    }
    ensure!(
        magic == [0xcf, 0xfa, 0xed, 0xfe] && prefix.get(4..8) == Some(&[12, 0, 0, 1][..]),
        "unsupported Mach-O architecture: Rieul macOS update candidates must contain only arm64 binaries"
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_arm64_and_non_macho_resources() {
        assert!(audit_prefix(&[0xcf, 0xfa, 0xed, 0xfe, 12, 0, 0, 1]).unwrap());
        assert!(!audit_prefix(b"#!/bin/sh").unwrap());
        assert!(!audit_prefix(b"PNG").unwrap());
    }
    #[test]
    fn rejects_intel_universal_and_truncated_macho() {
        for bytes in [
            &[0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1][..],
            &[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2][..],
            &[0xbe, 0xba, 0xfe, 0xca, 2, 0, 0, 0][..],
            &[0xcf, 0xfa, 0xed, 0xfe][..],
        ] {
            assert!(audit_prefix(bytes).is_err());
        }
    }
}
