//! Negotiated desktop media profile v1: one closed GOP per uni stream.
//! Each object is a big-endian u32 length followed by deterministic CBOR.
//! This profile must never be sent to a peer that has not opted in.
use crate::generated::rpc::DesktopMediaObject;
pub const MAX_OBJECT: usize = 4 * 1024 * 1024;
pub const MAX_GROUP_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_GROUP_OBJECTS: u64 = 240;
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Limit,
    Malformed,
    Truncated,
    Discontinuity,
}

/// Buffers at most one bounded object, even when a network chunk has many frames.
#[derive(Default)]
pub struct Frames {
    header: Vec<u8>,
    body: Vec<u8>,
    length: Option<usize>,
    failed: bool,
}
impl Frames {
    pub fn feed(
        &mut self,
        mut bytes: &[u8],
        mut consume: impl FnMut(&[u8]) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if self.failed {
            return Err(Error::Malformed);
        }
        let result = (|| {
            while !bytes.is_empty() {
                if self.length.is_none() {
                    let n = (4 - self.header.len()).min(bytes.len());
                    self.header.extend_from_slice(&bytes[..n]);
                    bytes = &bytes[n..];
                    if self.header.len() < 4 {
                        continue;
                    }
                    let length = u32::from_be_bytes(self.header[..].try_into().unwrap()) as usize;
                    if length == 0 || length > MAX_OBJECT {
                        return Err(Error::Limit);
                    }
                    self.length = Some(length);
                    self.header.clear();
                }
                let length = self.length.unwrap();
                let n = (length - self.body.len()).min(bytes.len());
                self.body.extend_from_slice(&bytes[..n]);
                bytes = &bytes[n..];
                if self.body.len() == length {
                    consume(&self.body)?;
                    self.body.clear();
                    self.length = None;
                }
            }
            Ok(())
        })();
        if result.is_err() {
            self.failed = true;
            self.body.clear();
            self.header.clear();
        }
        result
    }
    pub fn finish(self) -> Result<(), Error> {
        if self.failed || self.length.is_some() || !self.header.is_empty() {
            Err(Error::Truncated)
        } else {
            Ok(())
        }
    }
}
pub fn encode_object(object: &DesktopMediaObject) -> Result<Vec<u8>, Error> {
    if object.data.len() > MAX_OBJECT {
        return Err(Error::Limit);
    }
    let body = object.try_encode().map_err(|_| Error::Malformed)?;
    if body.is_empty() || body.len() > MAX_OBJECT {
        return Err(Error::Limit);
    }
    let mut result = (body.len() as u32).to_be_bytes().to_vec();
    result.extend(body);
    Ok(result)
}
/// A receiver creates this per stream after matching the expected track epochs.
/// STOP_SENDING/reset discards this whole group; recovery requires a new keyframe.
pub struct Group {
    attach: String,
    track: u64,
    layout: u64,
    codec: u64,
    group: u64,
    next_object: u64,
    bytes: usize,
    timestamp: Option<u64>,
    failed: bool,
}
impl Group {
    pub fn new(attach: String, track: u64, layout: u64, codec: u64, group: u64) -> Self {
        Self {
            attach,
            track,
            layout,
            codec,
            group,
            next_object: 0,
            bytes: 0,
            timestamp: None,
            failed: false,
        }
    }
    pub fn accept(&mut self, encoded: &[u8]) -> Result<DesktopMediaObject, Error> {
        if self.failed {
            return Err(Error::Discontinuity);
        }
        let result = (|| {
            self.bytes = self.bytes.checked_add(encoded.len()).ok_or(Error::Limit)?;
            if encoded.len() > MAX_OBJECT
                || self.bytes > MAX_GROUP_BYTES
                || self.next_object >= MAX_GROUP_OBJECTS
            {
                return Err(Error::Limit);
            }
            let o = DesktopMediaObject::decode(encoded).map_err(|_| Error::Malformed)?;
            if o.attach_id != self.attach
                || o.track_id != self.track
                || o.layout_epoch != self.layout
                || o.codec_epoch != self.codec
                || o.group_id != self.group
                || o.object_id != self.next_object
                || (o.object_id == 0) != o.keyframe
                || self.timestamp.is_some_and(|t| o.timestamp_micros < t)
                || o.data.is_empty()
            {
                return Err(Error::Discontinuity);
            }
            self.next_object += 1;
            self.timestamp = Some(o.timestamp_micros);
            Ok(o)
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn object() -> DesktopMediaObject {
        DesktopMediaObject {
            attach_id: "a".into(),
            track_id: 1,
            layout_epoch: 1,
            codec_epoch: 1,
            group_id: 2,
            object_id: 0,
            timestamp_micros: 100,
            keyframe: true,
            data: vec![1, 2, 3],
        }
    }
    #[test]
    fn media_codec_matches_typescript_golden() {
        let hex: String = object()
            .encode()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(hex, "a90161610201030104010502060007186408f50943010203");
    }
    #[test]
    fn fake_capture_codec_split_transport_roundtrip() {
        let first = object();
        let mut second = first.clone();
        second.object_id = 1;
        second.keyframe = false;
        second.timestamp_micros += 16_667;
        let bytes = [
            encode_object(&first).unwrap(),
            encode_object(&second).unwrap(),
        ]
        .concat();
        for chunk_size in [1, 2, 3, 4, 7, 1024] {
            let mut frames = Frames::default();
            let mut group = Group::new("a".into(), 1, 1, 1, 2);
            let mut received = vec![];
            for chunk in bytes.chunks(chunk_size) {
                frames
                    .feed(chunk, |b| {
                        received.push(group.accept(b)?);
                        Ok(())
                    })
                    .unwrap();
            }
            frames.finish().unwrap();
            assert_eq!(received, [first.clone(), second.clone()]);
        }
    }
    #[test]
    fn rejects_length_before_allocating_and_partial_eof() {
        let mut f = Frames::default();
        assert_eq!(
            f.feed(&u32::MAX.to_be_bytes(), |_| Ok(())),
            Err(Error::Limit)
        );
        assert!(f.body.is_empty());
        assert_eq!(f.feed(&[0], |_| Ok(())), Err(Error::Malformed));
        let mut f = Frames::default();
        f.feed(&[0, 0, 1], |_| Ok(())).unwrap();
        assert_eq!(f.finish(), Err(Error::Truncated));
    }
    #[test]
    fn missing_keyframe_stale_epoch_and_reordered_object_cancel_group() {
        for kind in 0..3 {
            let mut o = object();
            match kind {
                0 => o.keyframe = false,
                1 => o.codec_epoch += 1,
                _ => o.object_id = 2,
            }
            let mut g = Group::new("a".into(), 1, 1, 1, 2);
            assert_eq!(g.accept(&o.encode()), Err(Error::Discontinuity));
            assert!(g.accept(&object().encode()).is_err());
        }
        let mut fresh = Group::new("a".into(), 1, 1, 1, 2);
        assert!(fresh.accept(&object().encode()).is_ok());
    }
}
