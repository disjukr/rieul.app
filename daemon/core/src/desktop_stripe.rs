//! Profile 2: bounded atomic bundles of independent horizontal H.264 stripes.
//! Layout adapted from MIT voxl video::stripe_layout; see third_party/voxl.
//! The outer media object owns authentication/epochs/time/GOP sequencing.
use crate::generated::rpc::DesktopStripe;

pub const MAX_STRIPES: usize = 2;
pub const MAX_BUNDLE: usize = 4 * 1024 * 1024;
const MAGIC: &[u8; 3] = b"RS\x02";

/// Aligned upstream stripe layout, restricted to even NV12 dimensions and two
/// concurrent hardware sessions. A profile-2 full frame is a one-stripe bundle.
pub fn layout(height: u64, count: usize) -> Option<Vec<DesktopStripe>> {
    if height == 0 || height > 2160 || height % 2 != 0 || !(1..=MAX_STRIPES).contains(&count) {
        return None;
    }
    let each = (height.div_ceil(count as u64) + 15) & !15;
    let mut stripes = Vec::new();
    let mut y = 0;
    while y < height {
        let h = each.min(height - y);
        stripes.push(DesktopStripe { y, height: h });
        y += h;
    }
    Some(stripes)
}

pub fn valid_layout(height: u64, stripes: &[DesktopStripe]) -> bool {
    if stripes.is_empty() || stripes.len() > MAX_STRIPES || height == 0 || height > 2160 {
        return false;
    }
    let mut end = 0;
    for s in stripes {
        if s.y != end || s.y % 2 != 0 || s.height == 0 || s.height % 2 != 0 {
            return false;
        }
        let Some(next) = end.checked_add(s.height).filter(|n| *n <= height) else {
            return false;
        };
        end = next;
    }
    end == height
}

/// Split an aggregate rate without multiplying the negotiated budget.
pub fn rates(total: u32, height: u64, stripes: &[DesktopStripe]) -> Option<Vec<u32>> {
    if !valid_layout(height, stripes) || total < stripes.len() as u32 {
        return None;
    }
    let mut remaining = total;
    let mut result = Vec::with_capacity(stripes.len());
    for (index, stripe) in stripes.iter().enumerate() {
        let rate = if index + 1 == stripes.len() {
            remaining
        } else {
            (u64::from(total) * stripe.height / height) as u32
        };
        if rate == 0 || rate > remaining {
            return None;
        }
        remaining -= rate;
        result.push(rate);
    }
    Some(result)
}

/// Copy one horizontal region from tightly packed NV12. No capture API needed.
pub fn nv12_region(
    pixels: &[u8],
    width: usize,
    height: usize,
    stripe: &DesktopStripe,
) -> Option<Vec<u8>> {
    if width == 0
        || width > 3840
        || width % 2 != 0
        || height == 0
        || height > 2160
        || height % 2 != 0
    {
        return None;
    }
    let y = usize::try_from(stripe.y).ok()?;
    let h = usize::try_from(stripe.height).ok()?;
    if y % 2 != 0
        || h == 0
        || h % 2 != 0
        || y.checked_add(h)? > height
        || pixels.len() != width * height * 3 / 2
    {
        return None;
    }
    let mut result = Vec::with_capacity(width * h * 3 / 2);
    result.extend_from_slice(&pixels[y * width..(y + h) * width]);
    let uv = width * height + y / 2 * width;
    result.extend_from_slice(&pixels[uv..uv + h / 2 * width]);
    Some(result)
}

#[derive(Debug, PartialEq)]
pub struct Packet<'a> {
    pub index: u8,
    pub keyframe: bool,
    pub data: &'a [u8],
}

/// Header: 'RS', version 2, count; records: index:u8, flags:u8 (bit0=key),
/// length:u32be, Annex-B payload. Increasing unique indexes, no padding/trailer.
/// GOP start requires every negotiated stripe and an independent key for each.
pub fn decode(data: &[u8], stripes: usize, first: bool) -> Option<Vec<Packet<'_>>> {
    if !(1..=MAX_STRIPES).contains(&stripes) || data.len() > MAX_BUNDLE || data.get(..3)? != MAGIC {
        return None;
    }
    let count = *data.get(3)? as usize;
    if count == 0 || count > stripes || (first && count != stripes) {
        return None;
    }
    let mut packets = Vec::with_capacity(count);
    let mut offset = 4;
    for _ in 0..count {
        let index = *data.get(offset)?;
        let flags = *data.get(offset + 1)?;
        if index as usize >= stripes
            || flags > 1
            || (first && flags != 1)
            || packets
                .last()
                .is_some_and(|p: &Packet<'_>| p.index >= index)
        {
            return None;
        }
        let length =
            u32::from_be_bytes(data.get(offset + 2..offset + 6)?.try_into().ok()?) as usize;
        offset += 6;
        if length == 0 {
            return None;
        }
        let end = offset.checked_add(length)?;
        let bytes = data.get(offset..end)?;
        // Each independently configured stripe uses Annex B, never shared avcC.
        if !bytes.starts_with(&[0, 0, 0, 1]) && !bytes.starts_with(&[0, 0, 1]) {
            return None;
        }
        packets.push(Packet {
            index,
            keyframe: flags == 1,
            data: bytes,
        });
        offset = end;
    }
    (offset == data.len()).then_some(packets)
}

pub fn encode(packets: &[Packet<'_>], stripes: usize, first: bool) -> Option<Vec<u8>> {
    if packets.is_empty() || packets.len() > MAX_STRIPES {
        return None;
    }
    let size = packets.iter().try_fold(4usize, |sum, p| {
        sum.checked_add(6)?.checked_add(p.data.len())
    })?;
    if size > MAX_BUNDLE {
        return None;
    }
    let mut bytes = Vec::with_capacity(size);
    bytes.extend_from_slice(MAGIC);
    bytes.push(packets.len() as u8);
    for p in packets {
        bytes.push(p.index);
        bytes.push(u8::from(p.keyframe));
        bytes.extend_from_slice(&(p.data.len() as u32).to_be_bytes());
        bytes.extend_from_slice(p.data);
    }
    decode(&bytes, stripes, first)?;
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    const NAL: &[u8] = &[0, 0, 0, 1, 0x65, 1];
    #[test]
    fn layout_covers_nv12_without_gaps_overlap_or_overflow() {
        for height in (2..=2160).step_by(2) {
            for count in 1..=2 {
                assert!(valid_layout(height, &layout(height, count).unwrap()));
            }
        }
        assert!(layout(u64::MAX, 2).is_none());
        assert!(layout(721, 2).is_none());
        assert!(layout(720, 3).is_none());
        assert!(!valid_layout(
            720,
            &[
                DesktopStripe { y: 0, height: 368 },
                DesktopStripe {
                    y: 366,
                    height: 354
                }
            ]
        ));
    }
    #[test]
    fn atomic_first_object_and_selective_later_object_have_one_format() {
        let full = [
            Packet {
                index: 0,
                keyframe: true,
                data: NAL,
            },
            Packet {
                index: 1,
                keyframe: true,
                data: NAL,
            },
        ];
        let bytes = encode(&full, 2, true).unwrap();
        assert_eq!(decode(&bytes, 2, true).unwrap(), full);
        let changed = [Packet {
            index: 1,
            keyframe: false,
            data: NAL,
        }];
        let delta = encode(&changed, 2, false).unwrap();
        assert!(decode(&delta, 2, true).is_none());
        assert_eq!(decode(&delta, 2, false).unwrap(), changed);
        assert!(encode(&full[..1], 1, true).is_some());
    }
    #[test]
    fn malformed_bundle_never_partially_commits() {
        let full = [
            Packet {
                index: 0,
                keyframe: true,
                data: NAL,
            },
            Packet {
                index: 1,
                keyframe: true,
                data: NAL,
            },
        ];
        let bytes = encode(&full, 2, true).unwrap();
        for end in 0..bytes.len() {
            assert!(decode(&bytes[..end], 2, true).is_none());
        }
        let mut trailer = bytes.clone();
        trailer.push(0);
        assert!(decode(&trailer, 2, true).is_none());
        for (at, value) in [
            (2, 3),
            (3, 0),
            (3, 3),
            (4, 2),
            (5, 2),
            (5, 0),
            (16, 0),
            (17, 0),
        ] {
            let mut bad = bytes.clone();
            bad[at] = value;
            assert!(decode(&bad, 2, true).is_none(), "byte {at}");
        }
        let mut huge = bytes;
        huge[6..10].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(decode(&huge, 2, true).is_none());
        assert!(encode(
            &[Packet {
                index: 0,
                keyframe: true,
                data: &vec![0; MAX_BUNDLE]
            }],
            1,
            true
        )
        .is_none());
    }
}

#[cfg(test)]
mod region_tests {
    use super::*;
    #[test]
    fn split_preserves_luma_chroma_and_total_rate() {
        let stripes = layout(480, 2).unwrap();
        let pixels: Vec<u8> = (0..640 * 480 * 3 / 2)
            .map(|i| (i / 640 % 251) as u8)
            .collect();
        for stripe in &stripes {
            let part = nv12_region(&pixels, 640, 480, stripe).unwrap();
            assert_eq!(part.len(), 640 * stripe.height as usize * 3 / 2);
            assert_eq!(part[0], pixels[stripe.y as usize * 640]);
            assert_eq!(
                part[640 * stripe.height as usize],
                pixels[640 * 480 + stripe.y as usize / 2 * 640]
            );
        }
        for total in [2, 100_001, 50_000_000] {
            assert_eq!(
                rates(total, 480, &stripes).unwrap().iter().sum::<u32>(),
                total
            );
        }
        assert!(rates(1, 480, &stripes).is_none());
        assert!(nv12_region(&pixels[..pixels.len() - 1], 640, 480, &stripes[0]).is_none());
        assert!(nv12_region(&pixels, 640, 480, &DesktopStripe { y: 2, height: 480 }).is_none());
    }
}
