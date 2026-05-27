use std::collections::BTreeMap;

use thiserror::Error;

use crate::cbor::{CborError, Value};
use crate::traits::ServiceError;

#[derive(Debug, Error)]
pub enum RpcCodecError {
    #[error("cbor error: {0}")]
    Cbor(#[from] CborError),
    #[error("expected CBOR map")]
    ExpectedMap,
    #[error("expected CBOR array")]
    ExpectedArray,
    #[error("missing field {0}")]
    MissingField(u64),
    #[error("unexpected field type for field {0}")]
    WrongFieldType(u64),
    #[error("integer is out of range for field {0}")]
    IntegerOutOfRange(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum ProcId {
    StartPairing = 1,
    CompletePairing = 2,
    SubscribeRoots = 3,
    SubscribeDirectory = 4,
    ReadFile = 5,
    WriteFile = 6,
    CreateNodes = 7,
    RenamePaths = 8,
    DeletePaths = 9,
}

impl ProcId {
    pub fn as_u64(self) -> u64 {
        self as u64
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcErrorPayload {
    pub code: RpcErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum RpcErrorCode {
    BadMessage = 1,
    Unauthorized = 2,
    MissingPayload = 3,
    NotImplemented = 4,
    PermissionDenied = 6,
    NotFound = 7,
    AlreadyExists = 8,
    OperationFailed = 9,
    MalformedPayload = 10,
}

impl RpcErrorCode {
    pub fn from_u64(value: u64) -> Option<Self> {
        match value {
            1 => Some(Self::BadMessage),
            2 => Some(Self::Unauthorized),
            3 => Some(Self::MissingPayload),
            4 => Some(Self::NotImplemented),
            6 => Some(Self::PermissionDenied),
            7 => Some(Self::NotFound),
            8 => Some(Self::AlreadyExists),
            9 => Some(Self::OperationFailed),
            10 => Some(Self::MalformedPayload),
            _ => None,
        }
    }

    pub fn as_u64(self) -> u64 {
        self as u64
    }
}

impl RpcErrorPayload {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([
            (1, Value::U64(self.code.as_u64())),
            (2, Value::Text(self.message.clone())),
        ]))
        .encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            code: RpcErrorCode::from_u64(expect_u64(&map, 1)?)
                .ok_or(RpcCodecError::WrongFieldType(1))?,
            message: expect_text(&map, 2)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartPairingResponse {
    pub expires_at_unix: i64,
}

impl StartPairingResponse {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([(1, Value::I64(self.expires_at_unix))])).encode()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletePairingRequest {
    pub code: String,
    pub client_label: String,
}

impl CompletePairingRequest {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([
            (1, Value::Text(self.code.clone())),
            (2, Value::Text(self.client_label.clone())),
        ]))
        .encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            code: expect_text(&map, 1)?,
            client_label: expect_text(&map, 2)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletePairingResponse {
    pub client_id: String,
    pub client_secret: String,
}

impl CompletePairingResponse {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([
            (1, Value::Text(self.client_id.clone())),
            (2, Value::Text(self.client_secret.clone())),
        ]))
        .encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            client_id: expect_text(&map, 1)?,
            client_secret: expect_text(&map, 2)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscribeDirectoryReq {
    pub path: String,
}

impl SubscribeDirectoryReq {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([(1, Value::Text(self.path.clone()))])).encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            path: expect_text(&map, 1)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadFileReq {
    pub path: String,
}

impl ReadFileReq {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([(1, Value::Text(self.path.clone()))])).encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            path: expect_text(&map, 1)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadFileRes {
    pub bytes: Vec<u8>,
}

impl ReadFileRes {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([(1, Value::Bytes(self.bytes.clone()))])).encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            bytes: expect_bytes(&map, 1)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteFileReq {
    pub path: String,
    pub mode: WriteFileMode,
    pub bytes: Vec<u8>,
}

impl WriteFileReq {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([
            (1, Value::Text(self.path.clone())),
            (2, Value::U64(self.mode.as_u64())),
            (3, Value::Bytes(self.bytes.clone())),
        ]))
        .encode()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            path: expect_text(&map, 1)?,
            mode: WriteFileMode::from_u64(expect_u64(&map, 2)?)
                .ok_or(RpcCodecError::WrongFieldType(2))?,
            bytes: expect_bytes(&map, 3)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum WriteFileMode {
    CreateNew = 1,
    CreateOrReplace = 2,
}

impl WriteFileMode {
    pub fn from_u64(value: u64) -> Option<Self> {
        match value {
            1 => Some(Self::CreateNew),
            2 => Some(Self::CreateOrReplace),
            _ => None,
        }
    }

    pub fn as_u64(self) -> u64 {
        self as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum FsEntryKind {
    File = 1,
    Directory = 2,
    Symlink = 3,
    Other = 4,
}

impl FsEntryKind {
    pub fn from_u64(value: u64) -> Option<Self> {
        match value {
            1 => Some(Self::File),
            2 => Some(Self::Directory),
            3 => Some(Self::Symlink),
            4 => Some(Self::Other),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub kind: FsEntryKind,
    pub size: Option<u64>,
    pub modified_at_ms: Option<u64>,
    pub readonly: bool,
}

impl FsEntry {
    pub fn to_value(&self) -> Value {
        let mut map = BTreeMap::from([
            (1, Value::Text(self.name.clone())),
            (2, Value::Text(self.path.clone())),
            (3, Value::U64(self.kind as u64)),
            (6, Value::Bool(self.readonly)),
        ]);
        if let Some(size) = self.size {
            map.insert(4, Value::U64(size));
        }
        if let Some(modified_at_ms) = self.modified_at_ms {
            map.insert(5, Value::U64(modified_at_ms));
        }
        Value::Map(map)
    }

    pub fn from_value(value: &Value) -> Result<Self, RpcCodecError> {
        let Value::Map(map) = value else {
            return Err(RpcCodecError::ExpectedMap);
        };
        Ok(Self {
            name: expect_text(map, 1)?,
            path: expect_text(map, 2)?,
            kind: FsEntryKind::from_u64(expect_u64(map, 3)?)
                .ok_or(RpcCodecError::WrongFieldType(3))?,
            size: optional_u64(map, 4)?,
            modified_at_ms: optional_u64(map, 5)?,
            readonly: optional_bool(map, 6)?.unwrap_or(false),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootsTableEvent {
    Snapshot {
        rows: Vec<FsEntry>,
    },
    Patch {
        removes: Vec<RootEntryKey>,
        upserts: Vec<FsEntry>,
    },
    Closed {
        reason: RootsSubscriptionCloseReason,
    },
}

impl RootsTableEvent {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Snapshot { rows } => {
                union_value(1, BTreeMap::from([(1, fs_entries_value(rows))])).encode()
            }
            Self::Patch { removes, upserts } => union_value(
                2,
                BTreeMap::from([
                    (
                        1,
                        Value::Array(removes.iter().map(RootEntryKey::to_value).collect()),
                    ),
                    (2, fs_entries_value(upserts)),
                ]),
            )
            .encode(),
            Self::Closed { reason } => {
                union_value(3, BTreeMap::from([(1, reason.to_value())])).encode()
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectoryTableEvent {
    Snapshot {
        rows: Vec<FsEntry>,
    },
    Patch {
        removes: Vec<DirectoryEntryKey>,
        upserts: Vec<FsEntry>,
    },
    Closed {
        reason: DirectorySubscriptionCloseReason,
    },
}

impl DirectoryTableEvent {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Snapshot { rows } => {
                union_value(1, BTreeMap::from([(1, fs_entries_value(rows))])).encode()
            }
            Self::Patch { removes, upserts } => union_value(
                2,
                BTreeMap::from([
                    (
                        1,
                        Value::Array(removes.iter().map(DirectoryEntryKey::to_value).collect()),
                    ),
                    (2, fs_entries_value(upserts)),
                ]),
            )
            .encode(),
            Self::Closed { reason } => {
                union_value(3, BTreeMap::from([(1, reason.to_value())])).encode()
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootEntryKey {
    pub path: String,
}

impl RootEntryKey {
    fn to_value(&self) -> Value {
        Value::Map(BTreeMap::from([(1, Value::Text(self.path.clone()))]))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEntryKey {
    pub name: String,
}

impl DirectoryEntryKey {
    fn to_value(&self) -> Value {
        Value::Map(BTreeMap::from([(1, Value::Text(self.name.clone()))]))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootsSubscriptionCloseReason {
    Failed,
    PermissionLost,
    Unknown,
}

impl RootsSubscriptionCloseReason {
    fn to_value(&self) -> Value {
        match self {
            Self::Failed => union_value(0, BTreeMap::new()),
            Self::PermissionLost => union_value(1, BTreeMap::new()),
            Self::Unknown => union_value(2, BTreeMap::new()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectorySubscriptionCloseReason {
    Failed,
    Deleted,
    Moved { to: Option<String> },
    PermissionLost,
    ReplacedByNonDirectory,
    Unknown,
}

impl DirectorySubscriptionCloseReason {
    fn to_value(&self) -> Value {
        match self {
            Self::Failed => union_value(0, BTreeMap::new()),
            Self::Deleted => union_value(1, BTreeMap::new()),
            Self::Moved { to } => {
                let mut fields = BTreeMap::new();
                if let Some(to) = to {
                    fields.insert(1, Value::Text(to.clone()));
                }
                union_value(2, fields)
            }
            Self::PermissionLost => union_value(3, BTreeMap::new()),
            Self::ReplacedByNonDirectory => union_value(4, BTreeMap::new()),
            Self::Unknown => union_value(5, BTreeMap::new()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateNodesReq {
    pub nodes: Vec<CreateNodeOp>,
}

impl CreateNodesReq {
    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            nodes: expect_array(&map, 1)?
                .iter()
                .map(CreateNodeOp::from_value)
                .collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateNodeOp {
    pub path: String,
    pub spec: CreateNodeSpec,
}

impl CreateNodeOp {
    fn from_value(value: &Value) -> Result<Self, RpcCodecError> {
        let Value::Map(map) = value else {
            return Err(RpcCodecError::ExpectedMap);
        };
        Ok(Self {
            path: expect_text(map, 1)?,
            spec: CreateNodeSpec::from_value(map.get(&2).ok_or(RpcCodecError::MissingField(2))?)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateNodeSpec {
    File,
    Directory,
    Symlink { target: String },
    Hardlink { target: String },
}

impl CreateNodeSpec {
    fn from_value(value: &Value) -> Result<Self, RpcCodecError> {
        let (variant, fields) = expect_union(value)?;
        match variant {
            1 => Ok(Self::File),
            2 => Ok(Self::Directory),
            3 => Ok(Self::Symlink {
                target: expect_text(fields, 1)?,
            }),
            4 => Ok(Self::Hardlink {
                target: expect_text(fields, 1)?,
            }),
            _ => Err(RpcCodecError::WrongFieldType(2)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenamePathsReq {
    pub ops: Vec<RenamePathOp>,
}

impl RenamePathsReq {
    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            ops: expect_array(&map, 1)?
                .iter()
                .map(RenamePathOp::from_value)
                .collect::<Result<_, _>>()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenamePathOp {
    pub from: String,
    pub to: String,
}

impl RenamePathOp {
    fn from_value(value: &Value) -> Result<Self, RpcCodecError> {
        let Value::Map(map) = value else {
            return Err(RpcCodecError::ExpectedMap);
        };
        Ok(Self {
            from: expect_text(map, 1)?,
            to: expect_text(map, 2)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletePathsReq {
    pub paths: Vec<String>,
    pub mode: DeleteMode,
}

impl DeletePathsReq {
    pub fn decode(bytes: &[u8]) -> Result<Self, RpcCodecError> {
        let map = expect_map(Value::decode(bytes)?)?;
        Ok(Self {
            paths: expect_array(&map, 1)?
                .iter()
                .map(expect_text_value)
                .collect::<Result<_, _>>()?,
            mode: DeleteMode::from_u64(expect_u64(&map, 2)?)
                .ok_or(RpcCodecError::WrongFieldType(2))?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
pub enum DeleteMode {
    Trash = 1,
    Permanent = 2,
}

impl DeleteMode {
    pub fn from_u64(value: u64) -> Option<Self> {
        match value {
            1 => Some(Self::Trash),
            2 => Some(Self::Permanent),
            _ => None,
        }
    }

    pub fn as_u64(self) -> u64 {
        self as u64
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkMutationRes {
    pub results: Vec<BulkMutationItemResult>,
}

impl BulkMutationRes {
    pub fn encode(&self) -> Vec<u8> {
        Value::Map(BTreeMap::from([(
            1,
            Value::Array(
                self.results
                    .iter()
                    .map(BulkMutationItemResult::to_value)
                    .collect(),
            ),
        )]))
        .encode()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BulkMutationItemResult {
    Failed {
        index: u64,
        error: FsMutationItemError,
    },
    Ok {
        index: u64,
    },
}

impl BulkMutationItemResult {
    pub fn ok(index: usize) -> Self {
        Self::Ok {
            index: index as u64,
        }
    }

    pub fn failed(index: usize, error: ServiceError) -> Self {
        Self::Failed {
            index: index as u64,
            error: FsMutationItemError::from_service_error(error),
        }
    }

    fn to_value(&self) -> Value {
        match self {
            Self::Failed { index, error } => union_value(
                0,
                BTreeMap::from([(1, Value::U64(*index)), (2, error.to_value())]),
            ),
            Self::Ok { index } => union_value(1, BTreeMap::from([(1, Value::U64(*index))])),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsMutationItemError {
    Failed { message: String },
    PermissionDenied { message: String },
    NotFound { message: String },
    AlreadyExists { message: String },
    NotDirectory { message: String },
    NotFile { message: String },
    InvalidPath { message: String },
    Unsupported { message: String },
}

impl FsMutationItemError {
    fn from_service_error(error: ServiceError) -> Self {
        let message = error.to_string();
        match error {
            ServiceError::PermissionDenied => Self::PermissionDenied { message },
            ServiceError::NotFound => Self::NotFound { message },
            ServiceError::AlreadyExists => Self::AlreadyExists { message },
            ServiceError::NotDirectory => Self::NotDirectory { message },
            ServiceError::NotFile => Self::NotFile { message },
            ServiceError::InvalidPath => Self::InvalidPath { message },
            ServiceError::Unsupported => Self::Unsupported { message },
            ServiceError::OperationFailed(_) => Self::Failed { message },
        }
    }

    fn to_value(&self) -> Value {
        let (variant, message) = match self {
            Self::Failed { message } => (0, message),
            Self::PermissionDenied { message } => (1, message),
            Self::NotFound { message } => (2, message),
            Self::AlreadyExists { message } => (3, message),
            Self::NotDirectory { message } => (4, message),
            Self::NotFile { message } => (5, message),
            Self::InvalidPath { message } => (6, message),
            Self::Unsupported { message } => (7, message),
        };
        union_value(variant, BTreeMap::from([(1, Value::Text(message.clone()))]))
    }
}

fn fs_entries_value(rows: &[FsEntry]) -> Value {
    Value::Array(rows.iter().map(FsEntry::to_value).collect())
}

fn union_value(variant: u64, fields: BTreeMap<u64, Value>) -> Value {
    Value::Array(vec![Value::U64(variant), Value::Map(fields)])
}

fn expect_union(value: &Value) -> Result<(u64, &BTreeMap<u64, Value>), RpcCodecError> {
    let Value::Array(items) = value else {
        return Err(RpcCodecError::ExpectedArray);
    };
    if items.len() != 2 {
        return Err(RpcCodecError::WrongFieldType(0));
    }
    let Value::U64(variant) = items[0] else {
        return Err(RpcCodecError::WrongFieldType(0));
    };
    let Value::Map(fields) = &items[1] else {
        return Err(RpcCodecError::ExpectedMap);
    };
    Ok((variant, fields))
}

fn expect_map(value: Value) -> Result<BTreeMap<u64, Value>, RpcCodecError> {
    match value {
        Value::Map(map) => Ok(map),
        _ => Err(RpcCodecError::ExpectedMap),
    }
}

fn expect_u64(map: &BTreeMap<u64, Value>, field: u64) -> Result<u64, RpcCodecError> {
    match map.get(&field).ok_or(RpcCodecError::MissingField(field))? {
        Value::U64(value) => Ok(*value),
        _ => Err(RpcCodecError::WrongFieldType(field)),
    }
}

fn optional_u64(map: &BTreeMap<u64, Value>, field: u64) -> Result<Option<u64>, RpcCodecError> {
    match map.get(&field) {
        None => Ok(None),
        Some(Value::U64(value)) => Ok(Some(*value)),
        Some(_) => Err(RpcCodecError::WrongFieldType(field)),
    }
}

fn expect_text(map: &BTreeMap<u64, Value>, field: u64) -> Result<String, RpcCodecError> {
    match map.get(&field).ok_or(RpcCodecError::MissingField(field))? {
        Value::Text(value) => Ok(value.clone()),
        _ => Err(RpcCodecError::WrongFieldType(field)),
    }
}

fn expect_text_value(value: &Value) -> Result<String, RpcCodecError> {
    match value {
        Value::Text(value) => Ok(value.clone()),
        _ => Err(RpcCodecError::WrongFieldType(0)),
    }
}

fn optional_bool(map: &BTreeMap<u64, Value>, field: u64) -> Result<Option<bool>, RpcCodecError> {
    match map.get(&field) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(RpcCodecError::WrongFieldType(field)),
    }
}

fn expect_bytes(map: &BTreeMap<u64, Value>, field: u64) -> Result<Vec<u8>, RpcCodecError> {
    match map.get(&field).ok_or(RpcCodecError::MissingField(field))? {
        Value::Bytes(value) => Ok(value.clone()),
        _ => Err(RpcCodecError::WrongFieldType(field)),
    }
}

fn expect_array<'a>(
    map: &'a BTreeMap<u64, Value>,
    field: u64,
) -> Result<&'a [Value], RpcCodecError> {
    match map.get(&field).ok_or(RpcCodecError::MissingField(field))? {
        Value::Array(value) => Ok(value),
        _ => Err(RpcCodecError::WrongFieldType(field)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_pairing_roundtrip() {
        let request = CompletePairingRequest {
            code: "123456".to_string(),
            client_label: "browser".to_string(),
        };
        assert_eq!(
            CompletePairingRequest::decode(&request.encode()).unwrap(),
            request
        );

        let response = CompletePairingResponse {
            client_id: "client".to_string(),
            client_secret: "secret".to_string(),
        };
        assert_eq!(
            CompletePairingResponse::decode(&response.encode()).unwrap(),
            response
        );
    }

    #[test]
    fn read_file_response_roundtrip() {
        let response = ReadFileRes {
            bytes: b"hello".to_vec(),
        };
        assert_eq!(ReadFileRes::decode(&response.encode()).unwrap(), response);
    }

    #[test]
    fn filesystem_snapshot_encodes_rows() {
        let rows = vec![
            FsEntry {
                name: "foo.txt".to_string(),
                path: "C:\\tmp\\foo.txt".to_string(),
                kind: FsEntryKind::File,
                size: Some(1234),
                modified_at_ms: Some(1_710_000_000_000),
                readonly: false,
            },
            FsEntry {
                name: "docs".to_string(),
                path: "C:\\tmp\\docs".to_string(),
                kind: FsEntryKind::Directory,
                size: None,
                modified_at_ms: None,
                readonly: true,
            },
        ];
        let encoded = DirectoryTableEvent::Snapshot { rows: rows.clone() }.encode();
        let Value::Array(items) = Value::decode(&encoded).unwrap() else {
            panic!("expected event union");
        };
        assert_eq!(items.first(), Some(&Value::U64(1)));
        let Value::Map(fields) = &items[1] else {
            panic!("expected event fields");
        };
        let Value::Array(encoded_rows) = fields.get(&1).unwrap() else {
            panic!("expected rows");
        };
        assert_eq!(
            encoded_rows
                .iter()
                .map(FsEntry::from_value)
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
            rows
        );
    }
}
