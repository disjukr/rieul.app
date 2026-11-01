//! Pure image/physical-key conversion; exercised without Windows or a desktop.
/// Crop/scale BGRA into even-sized NV12. BT.709 limited-range, chroma averaged 2x2.
pub fn nv12(
    bytes: &[u8],
    source: (usize, usize, usize),
    crop: (usize, usize, usize, usize),
    output: (usize, usize),
) -> Option<Vec<u8>> {
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
    let mut result = vec![0; w * h * 3 / 2];
    let rgb = |x: usize, y: usize| {
        let offset = (cy + y * ch / h) * stride + (cx + x * cw / w) * 4;
        (
            bytes[offset + 2] as f64,
            bytes[offset + 1] as f64,
            bytes[offset] as f64,
        )
    };
    let byte = |n: f64| n.round().clamp(0.0, 255.0) as u8;
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = rgb(x, y);
            result[y * w + x] = byte(16.0 + 0.182586 * r + 0.614231 * g + 0.062007 * b);
        }
    }
    for y in (0..h).step_by(2) {
        for x in (0..w).step_by(2) {
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
    Some(result)
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
