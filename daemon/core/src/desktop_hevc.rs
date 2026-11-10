//! HEVC Main Annex B metadata for hardware encoders and WebCodecs. No decoder.
//! `hev1` permits parameter sets in-band; every independent packet must carry
//! VPS/SPS/PPS and an IDR. CRA pictures are deliberately not recovery points.
const MAX_PACKET: usize = 4 * 1024 * 1024;

fn nals(bytes: &[u8]) -> Option<Vec<&[u8]>> {
    if bytes.is_empty() || bytes.len() > MAX_PACKET {
        return None;
    }
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let length = if bytes[i..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[i..].starts_with(&[0, 0, 1]) {
            3
        } else {
            i += 1;
            continue;
        };
        starts.push((i, i + length));
        i += length;
    }
    if starts.first()?.0 != 0 {
        return None;
    }
    let mut out = Vec::new();
    for (index, (_, payload)) in starts.iter().enumerate() {
        let end = starts
            .get(index + 1)
            .map_or(bytes.len(), |(start, _)| *start);
        let nal = bytes.get(*payload..end)?;
        // Only single-layer streams with valid temporal_id_plus1 are supported.
        if nal.len() < 3 || nal[0] & 0x81 != 0 || nal[1] & 0xf8 != 0 || nal[1] & 7 == 0 {
            return None;
        }
        out.push(nal);
    }
    Some(out)
}

fn sps_codec(nal: &[u8]) -> Option<String> {
    // Remove emulation prevention before reading profile_tier_level.
    let mut rbsp = Vec::new();
    let mut zeros = 0;
    for (i, &b) in nal[2..].iter().enumerate() {
        if zeros >= 2 && b == 3 {
            if *nal.get(i + 3)? > 3 {
                return None;
            }
            zeros = 0;
            continue;
        }
        rbsp.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    let ptl = rbsp.get(1..13)?;
    let space = ["", "A", "B", "C"][(ptl[0] >> 6) as usize];
    let profile = ptl[0] & 31;
    let tier = if ptl[0] & 32 == 0 { 'L' } else { 'H' };
    let compatibility = u32::from_be_bytes(ptl[1..5].try_into().ok()?).reverse_bits();
    let mut codec = format!("hev1.{space}{profile}.{compatibility:X}.{tier}{}", ptl[11]);
    if let Some(last) = ptl[5..11].iter().rposition(|b| *b != 0) {
        for byte in &ptl[5..=5 + last] {
            codec.push_str(&format!(".{byte:02X}"));
        }
    }
    Some(codec)
}

/// RFC 6381 metadata from the actual SPS, only for self-contained IDR packets.
pub fn codec(bytes: &[u8]) -> Option<String> {
    let mut codec = None;
    let (mut vps, mut pps, mut idr) = (false, false, false);
    for nal in nals(bytes)? {
        match (nal[0] >> 1) & 63 {
            32 => vps = true,
            33 => {
                let current = sps_codec(nal)?;
                if codec.as_ref().is_some_and(|old| old != &current) {
                    return None;
                }
                codec = Some(current);
            }
            34 => pps = true,
            19 | 20 => idr = true,
            _ => {}
        }
    }
    if vps && pps && idr {
        codec
    } else {
        None
    }
}

/// Cache complete VPS/SPS/PPS for encoders that omit them on later IDRs.
pub fn headers(bytes: &[u8]) -> Vec<u8> {
    let Some(nals) = nals(bytes) else {
        return vec![];
    };
    let mut present = 0;
    let mut out = Vec::new();
    for nal in nals {
        let kind = (nal[0] >> 1) & 63;
        if (32..=34).contains(&kind) {
            if kind == 33 && sps_codec(nal).is_none() {
                return vec![];
            }
            present |= 1 << (kind - 32);
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(nal);
        }
    }
    if present == 7 {
        out
    } else {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(tier: bool, constraints: [u8; 6]) -> Vec<u8> {
        let mut out = vec![0, 0, 1, 64, 1, 0x80, 0, 0, 0, 1, 66, 1];
        let mut sps = vec![1, 1 | if tier { 32 } else { 0 }, 0x60, 0, 0, 0];
        sps.extend_from_slice(&constraints);
        sps.extend_from_slice(&[153, 0x80]);
        let mut zeros = 0;
        for b in sps {
            if zeros >= 2 && b <= 3 {
                out.push(3);
                zeros = 0;
            }
            out.push(b);
            zeros = if b == 0 { zeros + 1 } else { 0 };
        }
        out.extend_from_slice(&[0, 0, 1, 68, 1, 0x80, 0, 0, 1, 38, 1, 0x80]);
        out
    }
    #[test]
    fn codec_uses_actual_sps_and_unescapes_rbsp() {
        assert_eq!(
            codec(&packet(false, [0xb0, 0, 0, 0, 0, 0])).as_deref(),
            Some("hev1.1.6.L153.B0")
        );
        assert_eq!(
            codec(&packet(true, [0, 0, 0, 0, 0, 1])).as_deref(),
            Some("hev1.1.6.H153.00.00.00.00.00.01")
        );
        assert_eq!(
            codec(&packet(false, [0; 6])).as_deref(),
            Some("hev1.1.6.L153")
        );
    }
    #[test]
    fn recovery_requires_complete_parameter_sets_and_idr() {
        let p = packet(false, [0xb0, 0, 0, 0, 0, 0]);
        let headers = headers(&p);
        assert!(codec(&headers).is_none());
        let mut recovered = headers.clone();
        recovered.extend_from_slice(&[0, 0, 1, 40, 1, 0x80]);
        assert_eq!(codec(&recovered), codec(&p));
        let mut cra = headers;
        cra.extend_from_slice(&[0, 0, 1, 42, 1, 0x80]);
        assert!(codec(&cra).is_none());
        assert!(codec(&p[6..]).is_none());
        assert!(super::headers(&p[6..]).is_empty());
    }
    #[test]
    fn rejects_truncated_or_invalid_nal_headers() {
        for p in [
            vec![],
            vec![0, 0, 1],
            vec![0, 0, 1, 66, 1],
            vec![0, 0, 1, 66, 0, 1],
            vec![0, 0, 1, 66, 9, 1],
            vec![0, 0, 1, 194, 1, 1],
        ] {
            assert!(codec(&p).is_none());
            assert!(headers(&p).is_empty());
        }
        assert!(codec(&[0, 0, 0, 5, 66, 1, 1, 1, 1]).is_none());
    }
}
