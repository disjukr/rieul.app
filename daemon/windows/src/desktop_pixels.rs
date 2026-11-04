//! Pure image/physical-key conversion; exercised without Windows or a desktop.
/// Crop/scale BGRA into even-sized NV12. BT.709 limited-range, chroma averaged 2x2.
pub fn nv12(
    bytes: &[u8],
    source: (usize, usize, usize),
    crop: (usize, usize, usize, usize),
    output: (usize, usize),
) -> Option<Vec<u8>> {
    let mut result = vec![];
    nv12_update(bytes, source, crop, output, &[], &mut result)?;
    Some(result)
}
/// Update retained NV12 only where nearest-neighbour sampling intersects source
/// damage. Expand to complete 2x2 chroma blocks; first output is always full.
pub fn nv12_update(
    bytes: &[u8],
    source: (usize, usize, usize),
    crop: (usize, usize, usize, usize),
    output: (usize, usize),
    damage: &[(u32, u32, u32, u32)],
    result: &mut Vec<u8>,
) -> Option<()> {
    let (sw, sh, stride) = source;
    let (cx, cy, cw, ch) = crop;
    let (w, h) = output;
    if w == 0
        || h == 0
        || w % 2 != 0
        || h % 2 != 0
        || w > 3840
        || h > 2160
        || cw == 0
        || ch == 0
        || stride < sw.checked_mul(4)?
        || bytes.len() < stride.checked_mul(sh)?
        || cx.checked_add(cw)? > sw
        || cy.checked_add(ch)? > sh
    {
        return None;
    }
    let mut region = None;
    if result.len() != w * h * 3 / 2 {
        result.resize(w * h * 3 / 2, 0);
        region = Some((0, 0, w, h));
    } else {
        for &(x0, y0, x1, y1) in damage {
            let (x0, y0, x1, y1) = (x0 as usize, y0 as usize, x1 as usize, y1 as usize);
            if x0 >= x1 || y0 >= y1 || x1 > sw || y1 > sh {
                return None;
            }
            let (left, top, right, bottom) =
                (x0.max(cx), y0.max(cy), x1.min(cx + cw), y1.min(cy + ch));
            if left >= right || top >= bottom {
                continue;
            }
            let l = ((left - cx) * w).div_ceil(cw) & !1;
            let t = ((top - cy) * h).div_ceil(ch) & !1;
            let r = ((((right - cx) * w).div_ceil(cw) + 1) & !1).min(w);
            let b = ((((bottom - cy) * h).div_ceil(ch) + 1) & !1).min(h);
            if l >= r || t >= b {
                continue;
            }
            region = Some(match region {
                None => (l, t, r, b),
                Some((a, c, d, e)) => (l.min(a), t.min(c), r.max(d), b.max(e)),
            });
        }
    }
    let Some((left, top, right, bottom)) = region else {
        return Some(());
    };
    let rgb = |x: usize, y: usize| {
        let offset = (cy + y * ch / h) * stride + (cx + x * cw / w) * 4;
        (
            bytes[offset + 2] as f64,
            bytes[offset + 1] as f64,
            bytes[offset] as f64,
        )
    };
    let byte = |n: f64| n.round().clamp(0.0, 255.0) as u8;
    for y in top..bottom {
        for x in left..right {
            let (r, g, b) = rgb(x, y);
            result[y * w + x] = byte(16.0 + 0.182586 * r + 0.614231 * g + 0.062007 * b);
        }
    }
    for y in (top..bottom).step_by(2) {
        for x in (left..right).step_by(2) {
            let (mut r, mut g, mut b) = (0.0, 0.0, 0.0);
            for dy in 0..2 {
                for dx in 0..2 {
                    let color = rgb(x + dx, y + dy);
                    r += color.0 / 4.0;
                    g += color.1 / 4.0;
                    b += color.2 / 4.0;
                }
            }
            let offset = w * h + y / 2 * w + x;
            result[offset] = byte(128.0 - 0.100644 * r - 0.338572 * g + 0.439216 * b);
            result[offset + 1] = byte(128.0 + 0.439216 * r - 0.398942 * g - 0.040274 * b);
        }
    }
    Some(())
}
/// HID keyboard-page usage to set-1 scan code + E0 prefix. Pause/PrintScreen need
/// special sequences and are deliberately unsupported instead of guessing.
pub fn scan_code(usage: u64) -> Option<(u16, bool)> {
    let code = match usage {
        4 => 0x1e,
        5 => 0x30,
        6 => 0x2e,
        7 => 0x20,
        8 => 0x12,
        9 => 0x21,
        10 => 0x22,
        11 => 0x23,
        12 => 0x17,
        13 => 0x24,
        14 => 0x25,
        15 => 0x26,
        16 => 0x32,
        17 => 0x31,
        18 => 0x18,
        19 => 0x19,
        20 => 0x10,
        21 => 0x13,
        22 => 0x1f,
        23 => 0x14,
        24 => 0x16,
        25 => 0x2f,
        26 => 0x11,
        27 => 0x2d,
        28 => 0x15,
        29 => 0x2c,
        30..=38 => (usage - 28) as u16,
        39 => 0x0b,
        40 => 0x1c,
        41 => 1,
        42 => 0x0e,
        43 => 0x0f,
        44 => 0x39,
        45 => 0x0c,
        46 => 0x0d,
        47 => 0x1a,
        48 => 0x1b,
        49 => 0x2b,
        51 => 0x27,
        52 => 0x28,
        53 => 0x29,
        54 => 0x33,
        55 => 0x34,
        56 => 0x35,
        57 => 0x3a,
        58..=67 => (usage - 58 + 0x3b) as u16,
        68 => 0x57,
        69 => 0x58,
        71 => 0x46,
        73 => 0x152,
        74 => 0x147,
        75 => 0x149,
        76 => 0x153,
        77 => 0x14f,
        78 => 0x151,
        79 => 0x14d,
        80 => 0x14b,
        81 => 0x150,
        82 => 0x148,
        83 => 0x45,
        84 => 0x135,
        85 => 0x37,
        86 => 0x4a,
        87 => 0x4e,
        88 => 0x11c,
        89 => 0x4f,
        90 => 0x50,
        91 => 0x51,
        92 => 0x4b,
        93 => 0x4c,
        94 => 0x4d,
        95 => 0x47,
        96 => 0x48,
        97 => 0x49,
        98 => 0x52,
        99 => 0x53,
        100 => 0x56,
        101 => 0x15d,
        224 => 0x1d,
        225 => 0x2a,
        226 => 0x38,
        227 => 0x15b,
        228 => 0x11d,
        229 => 0x36,
        230 => 0x138,
        231 => 0x15c,
        _ => return None,
    };
    Some((code & 255, code > 255))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn black_and_white_nv12() {
        for (rgb, y) in [(0, 16), (255, 235)] {
            let bytes = vec![rgb; 16];
            assert_eq!(
                nv12(&bytes, (2, 2, 8), (0, 0, 2, 2), (2, 2)).unwrap(),
                vec![y, y, y, y, 128, 128]
            );
        }
    }
    #[test]
    fn bounds_and_crop() {
        assert!(nv12(&[], (2, 2, 8), (0, 0, 2, 2), (2, 2)).is_none());
        assert!(nv12(&[0; 16], (2, 2, 8), (1, 0, 2, 2), (2, 2)).is_none());
        assert!(nv12(&[0; 16], (2, 2, 8), (0, 0, 2, 2), (1, 2)).is_none());
    }
    #[test]
    fn physical_sides_and_keypad() {
        assert_eq!(scan_code(224), Some((0x1d, false)));
        assert_eq!(scan_code(228), Some((0x1d, true)));
        assert_eq!(scan_code(40), Some((0x1c, false)));
        assert_eq!(scan_code(88), Some((0x1c, true)));
        assert_eq!(scan_code(72), None);
    }
}

/// Copy SPS/PPS NAL units from Annex B; bounded by the already checked packet size.
pub fn annex_b_headers(bytes: &[u8]) -> Vec<u8> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
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
    let mut output = Vec::new();
    let (mut sps, mut pps) = (false, false);
    for (index, (_, payload)) in starts.iter().enumerate() {
        if *payload >= bytes.len() {
            continue;
        }
        let kind = bytes[*payload] & 31;
        if kind == 7 || kind == 8 {
            let end = starts
                .get(index + 1)
                .map(|(start, _)| *start)
                .unwrap_or(bytes.len());
            output.extend_from_slice(&[0, 0, 0, 1]);
            output.extend_from_slice(&bytes[*payload..end]);
            sps |= kind == 7;
            pps |= kind == 8;
        }
    }
    if sps && pps {
        output
    } else {
        vec![]
    }
}

/// Bounded RGBA PNG using stored DEFLATE blocks; avoids an image-library/codec
/// dependency in the privileged IPC path. Cursor shapes are small, at most 128².
pub fn cursor_png(width: usize, height: usize, rgba: &[u8]) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || width > 128 || height > 128 || rgba.len() != width * height * 4
    {
        return None;
    }
    fn crc(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff;
        for b in bytes {
            crc ^= *b as u32;
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320u32.wrapping_mul(crc & 1));
            }
        }
        !crc
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let checksum = crc(&out[start..]);
        out.extend_from_slice(&checksum.to_be_bytes());
    }
    let mut raw = Vec::with_capacity((width * 4 + 1) * height);
    for row in rgba.chunks_exact(width * 4) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut zlib = vec![0x78, 0x01];
    let mut offset = 0;
    while offset < raw.len() {
        let n = (raw.len() - offset).min(65535);
        zlib.push(u8::from(offset + n == raw.len()));
        zlib.extend_from_slice(&(n as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(n as u16)).to_le_bytes());
        zlib.extend_from_slice(&raw[offset..offset + n]);
        offset += n;
    }
    let (mut a, mut b) = (1u32, 0u32);
    for byte in raw {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
    let mut header = Vec::new();
    header.extend_from_slice(&(width as u32).to_be_bytes());
    header.extend_from_slice(&(height as u32).to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    Some(out)
}
#[cfg(test)]
mod codec_tests {
    use super::*;
    #[test]
    fn independent_parameter_sets() {
        let bytes = [
            0, 0, 0, 1, 0x67, 66, 0xe0, 42, 0, 0, 1, 0x68, 1, 2, 0, 0, 1, 0x65, 3,
        ];
        assert_eq!(
            annex_b_headers(&bytes),
            vec![0, 0, 0, 1, 0x67, 66, 0xe0, 42, 0, 0, 0, 1, 0x68, 1, 2]
        );
        assert!(annex_b_headers(&[0, 0, 1, 0x65, 1]).is_empty());
    }
    #[test]
    fn png_bounds_and_signature() {
        let png = cursor_png(1, 1, &[255, 0, 0, 255]).unwrap();
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert_eq!(&png[png.len() - 8..], &[73, 69, 78, 68, 174, 66, 96, 130]);
        assert!(cursor_png(129, 1, &[]).is_none());
    }
}

/// Conservative AV1 low-overhead OBU profile: one operating point, no timing model,
/// main profile, 8-bit 4:2:0. Other streams remain unadvertised rather than guessed.
pub fn av1_sequence_codec(sequence: &[u8]) -> Option<String> {
    struct Bits<'a>(&'a [u8], usize);
    impl Bits<'_> {
        fn take(&mut self, n: usize) -> Option<u32> {
            if n > 32 || self.1.checked_add(n)? > self.0.len() * 8 {
                return None;
            }
            let mut v = 0;
            for _ in 0..n {
                v = (v << 1) | ((self.0[self.1 / 8] >> (7 - self.1 % 8)) & 1) as u32;
                self.1 += 1;
            }
            Some(v)
        }
    }
    let mut b = Bits(sequence, 0);
    if b.take(3)? != 0 {
        return None;
    }
    let still = b.take(1)?;
    let reduced = b.take(1)?;
    if reduced != 0 || still != 0 || b.take(1)? != 0 {
        return None;
    }
    let delay = b.take(1)?;
    if b.take(5)? != 0 || b.take(12)? != 0 {
        return None;
    }
    let level = b.take(5)?;
    if level > 23 {
        return None;
    }
    let tier = if level > 7 { b.take(1)? } else { 0 };
    if delay != 0 && b.take(1)? != 0 {
        b.take(4)?;
    }
    let wb = b.take(4)? as usize + 1;
    let hb = b.take(4)? as usize + 1;
    b.take(wb)?;
    b.take(hb)?;
    if b.take(1)? != 0 {
        b.take(7)?;
    }
    b.take(3)?; // superblock/filter-intra/intra-edge
    b.take(4)?; // inter-intra/masked compound/warped motion/dual filter
    let order = b.take(1)?;
    if order != 0 {
        b.take(2)?;
    }
    let screen = if b.take(1)? != 0 { 2 } else { b.take(1)? };
    if screen != 0 && b.take(1)? == 0 {
        b.take(1)?;
    }
    if order != 0 {
        b.take(3)?;
    }
    b.take(3)?; // superres/CDEF/restoration
    if b.take(1)? != 0 || b.take(1)? != 0 {
        return None;
    } // high bitdepth / monochrome
    Some(format!(
        "av01.0.{level:02}{}.08",
        if tier == 0 { 'M' } else { 'H' }
    ))
}
/// Normalize a clean-point sample to one independently decodable temporal unit.
/// `sequence` persists only within one codec epoch. No cross-group frame references.
pub fn av1_independent(bytes: &[u8], sequence: &mut Vec<u8>) -> Option<(String, Vec<u8>)> {
    if bytes.len() > 4 * 1024 * 1024 {
        return None;
    }
    let mut i = 0usize;
    let mut body = Vec::new();
    let mut seq = sequence.clone();
    let mut frame = false;
    while i < bytes.len() {
        let start = i;
        let header = *bytes.get(i)?;
        i += 1;
        if header & 0x85 != 0 || header & 2 == 0 {
            return None;
        } // no forbidden/reserved/extension bits
        let kind = (header >> 3) & 15;
        let mut size = 0usize;
        let mut finished = false;
        for shift in (0..56).step_by(7) {
            let v = *bytes.get(i)?;
            i += 1;
            size = size.checked_add(((v & 127) as usize).checked_shl(shift)?)?;
            if v & 128 == 0 {
                finished = true;
                break;
            }
        }
        if !finished {
            return None;
        }
        let end = i.checked_add(size)?;
        let payload = bytes.get(i..end)?;
        match kind {
            1 => {
                if frame || av1_sequence_codec(payload).is_none() {
                    return None;
                }
                seq = bytes[start..end].to_vec();
            }
            2 => {
                if size != 0 || frame {
                    return None;
                }
            }
            3 | 6 => {
                if frame || payload.first()? >> 4 != 1 {
                    return None;
                }
                frame = true;
                body.extend_from_slice(&bytes[start..end]);
            }
            _ => body.extend_from_slice(&bytes[start..end]),
        }
        i = end;
    }
    if !frame || seq.is_empty() {
        return None;
    }
    // Parse the stored sequence's LEB length again without trusting cached offsets.
    let mut offset = 1;
    while *seq.get(offset)? & 128 != 0 {
        offset += 1;
        if offset > 8 {
            return None;
        }
    }
    offset += 1;
    let codec = av1_sequence_codec(seq.get(offset..)?)?;
    let mut packet = vec![0x12, 0];
    packet.extend_from_slice(&seq);
    packet.extend_from_slice(&body);
    if packet.len() > 4 * 1024 * 1024 {
        return None;
    }
    *sequence = seq;
    Some((codec, packet))
}
#[cfg(test)]
mod av1_tests {
    use super::*;
    fn sequence() -> Vec<u8> {
        let fields: &[(u32, usize)] = &[
            (0, 3),
            (0, 1),
            (0, 1),
            (0, 1),
            (0, 1),
            (0, 5),
            (0, 12),
            (13, 5),
            (0, 1),
            (0, 4),
            (0, 4),
            (0, 1),
            (0, 1),
            (0, 1),
            (0, 3),
            (0, 4),
            (0, 1),
            (0, 1),
            (0, 1),
            (0, 3),
            (0, 1),
            (0, 1),
        ];
        let mut bits = vec![];
        for &(v, n) in fields {
            for i in (0..n).rev() {
                bits.push(((v >> i) & 1) as u8);
            }
        }
        let mut bytes = vec![0; bits.len().div_ceil(8)];
        for (i, v) in bits.into_iter().enumerate() {
            bytes[i / 8] |= v << (7 - i % 8);
        }
        bytes
    }
    #[test]
    fn sequence_and_group_bounds() {
        let s = sequence();
        assert_eq!(av1_sequence_codec(&s).as_deref(), Some("av01.0.13M.08"));
        let mut bytes = vec![0x0a, s.len() as u8];
        bytes.extend_from_slice(&s);
        bytes.extend([0x32, 1, 0x10]);
        let mut headers = vec![];
        let (codec, packet) = av1_independent(&bytes, &mut headers).unwrap();
        assert_eq!(codec, "av01.0.13M.08");
        assert!(packet.starts_with(&[0x12, 0]));
        assert!(av1_independent(&[0x32, 1, 0x10], &mut headers).is_some());
        for bytes in [
            &[0x32, 1, 0x20][..],
            &[0x32, 4, 0x10],
            &[0x0a, 0xff],
            &[0x36, 0],
        ] {
            assert!(av1_independent(bytes, &mut headers).is_none());
        }
        assert!(av1_independent(&[0x32, 1, 0x10], &mut vec![]).is_none());
        for n in 0..s.len() {
            assert!(av1_sequence_codec(&s[..n]).is_none());
        }
    }
}

/// Rectangle clipping adapted from tembo/voxl win/capture.rs::frame_rects
/// a24c7171 (MIT; third_party/voxl/LICENSE). Empty/outside regions are ignored.
pub fn clip_damage(
    r: (i32, i32, i32, i32),
    width: u32,
    height: u32,
) -> Option<(u32, u32, u32, u32)> {
    if width > 8192 || height > 8192 {
        return None;
    }
    let (w, h) = (width as i32, height as i32);
    let (x0, y0) = (r.0.clamp(0, w), r.1.clamp(0, h));
    let (x1, y1) = (r.2.clamp(0, w), r.3.clamp(0, h));
    (x1 > x0 && y1 > y0).then_some((x0 as u32, y0 as u32, x1 as u32, y1 as u32))
}
#[cfg(test)]
mod damage_tests {
    use super::*;
    #[test]
    fn clips_negative_and_oversized_damage_without_wrapping() {
        assert_eq!(
            clip_damage((-20, -1, 100, 100), 64, 32),
            Some((0, 0, 64, 32))
        );
        assert_eq!(clip_damage((65, 0, i32::MAX, i32::MAX), 64, 32), None);
        assert_eq!(clip_damage((20, 10, 5, 2), 64, 32), None);
        assert_eq!(clip_damage((0, 0, 4, 4), u32::MAX, 32), None);
    }
}

#[cfg(test)]
mod partial_tests {
    use super::*;
    #[test]
    fn partial_conversion_matches_full_for_crop_scale_odd_damage_and_chroma_edges() {
        for (w, h) in [(2, 2), (6, 4), (16, 12)] {
            for crop in [(0, 0, 13, 9), (1, 1, 11, 7), (3, 2, 7, 6)] {
                let stride = 13 * 4 + 8;
                let mut bgra: Vec<u8> = (0..stride * 9).map(|n| (n * 17 % 251) as u8).collect();
                let mut retained = nv12(&bgra, (13, 9, stride), crop, (w, h)).unwrap();
                for (x0, y0, x1, y1) in [
                    (0, 0, 1, 1),
                    (3, 3, 4, 4),
                    (2, 1, 8, 6),
                    (12, 8, 13, 9),
                    (0, 0, 13, 9),
                ] {
                    for y in y0..y1 {
                        for x in x0..x1 {
                            for c in 0..3 {
                                bgra[y * stride + x * 4 + c] ^= 0x7f;
                            }
                        }
                    }
                    nv12_update(
                        &bgra,
                        (13, 9, stride),
                        crop,
                        (w, h),
                        &[(x0 as u32, y0 as u32, x1 as u32, y1 as u32)],
                        &mut retained,
                    )
                    .unwrap();
                    assert_eq!(
                        retained,
                        nv12(&bgra, (13, 9, stride), crop, (w, h)).unwrap(),
                        "crop={crop:?},out={w}x{h},damage={x0},{y0},{x1},{y1}"
                    );
                }
                let previous = retained.clone();
                nv12_update(&bgra, (13, 9, stride), crop, (w, h), &[], &mut retained).unwrap();
                assert_eq!(previous, retained);
            }
        }
    }
}

/// Copy only validated dirty rows from a mapped BGRA surface into tight retained
/// CPU storage. Validate the entire batch before modifying destination bytes.
pub fn copy_bgra_damage(
    source: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    damage: &[(u32, u32, u32, u32)],
    target: &mut Vec<u8>,
) -> Option<()> {
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || stride < width * 4
        || source.len() < stride.checked_mul(height)?
    {
        return None;
    }
    for &(x0, y0, x1, y1) in damage {
        if x0 >= x1 || y0 >= y1 || x1 as usize > width || y1 as usize > height {
            return None;
        }
    }
    let first = target.len() != width * height * 4;
    target.resize(width * height * 4, 0);
    let full = [(0, 0, width as u32, height as u32)];
    let rects = if first { &full[..] } else { damage };
    for &(x0, y0, x1, y1) in rects {
        for y in y0 as usize..y1 as usize {
            let from = y * stride + x0 as usize * 4;
            let to = (y * width + x0 as usize) * 4;
            let count = (x1 - x0) as usize * 4;
            target[to..to + count].copy_from_slice(&source[from..from + count]);
        }
    }
    Some(())
}
#[cfg(test)]
mod readback_tests {
    use super::*;
    #[test]
    fn padded_readback_retains_unchanged_pixels_and_invalid_batch_is_atomic() {
        let mut source: Vec<u8> = (0..24 * 4).map(|n| n as u8).collect();
        let mut target = vec![];
        copy_bgra_damage(&source, 4, 4, 24, &[], &mut target).unwrap();
        let old = target.clone();
        source[24 + 4..24 + 8].fill(200);
        copy_bgra_damage(&source, 4, 4, 24, &[(1, 1, 2, 2)], &mut target).unwrap();
        for i in 0..target.len() {
            assert_eq!(target[i], if (20..24).contains(&i) { 200 } else { old[i] });
        }
        let old = target.clone();
        assert!(copy_bgra_damage(
            &source,
            4,
            4,
            24,
            &[(1, 1, 2, 2), (3, 3, 5, 4)],
            &mut target
        )
        .is_none());
        assert_eq!(target, old);
    }
}
