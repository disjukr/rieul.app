pub use crate::generated::ipc::{
    ActivateGuiReq, ConfirmPairingReq, ConfirmPairingRes, IpcProcError, ProcId, RpcRequest,
    RpcRequestDecodeError, RpcResponse, ShowDaemonInfoReq, ShowPairingCodeReq, SnapshotWindowsRes,
};

pub type IpcCodecError = crate::generated::ipc::CodecError;

pub fn failed_error(message: impl Into<String>) -> IpcProcError {
    IpcProcError::Failed {
        message: message.into(),
    }
}

pub fn unsupported_error(message: impl Into<String>) -> IpcProcError {
    IpcProcError::Unsupported {
        message: message.into(),
    }
}

impl From<crate::rpc::WindowInfo> for crate::generated::ipc::WindowInfo {
    fn from(value: crate::rpc::WindowInfo) -> Self {
        Self {
            window_id: value.window_id,
            title: value.title,
            process_id: value.process_id,
            focused: value.focused,
        }
    }
}

impl From<crate::rpc::WindowState> for crate::generated::ipc::WindowState {
    fn from(value: crate::rpc::WindowState) -> Self {
        Self {
            visible: value.visible,
            minimized: value.minimized,
            maximized: value.maximized,
        }
    }
}

impl From<crate::rpc::WindowBounds> for crate::generated::ipc::WindowBounds {
    fn from(value: crate::rpc::WindowBounds) -> Self {
        Self {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

impl From<crate::rpc::WindowDetail> for crate::generated::ipc::WindowDetail {
    fn from(value: crate::rpc::WindowDetail) -> Self {
        Self {
            info: value.info.into(),
            state: value.state.into(),
            bounds: value.bounds.map(Into::into),
        }
    }
}

impl From<crate::generated::ipc::WindowInfo> for crate::rpc::WindowInfo {
    fn from(value: crate::generated::ipc::WindowInfo) -> Self {
        Self {
            window_id: value.window_id,
            title: value.title,
            process_id: value.process_id,
            focused: value.focused,
        }
    }
}

impl From<crate::generated::ipc::WindowState> for crate::rpc::WindowState {
    fn from(value: crate::generated::ipc::WindowState) -> Self {
        Self {
            visible: value.visible,
            minimized: value.minimized,
            maximized: value.maximized,
        }
    }
}

impl From<crate::generated::ipc::WindowBounds> for crate::rpc::WindowBounds {
    fn from(value: crate::generated::ipc::WindowBounds) -> Self {
        Self {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

impl From<crate::generated::ipc::WindowDetail> for crate::rpc::WindowDetail {
    fn from(value: crate::generated::ipc::WindowDetail) -> Self {
        Self {
            info: value.info.into(),
            state: value.state.into(),
            bounds: value.bounds.map(Into::into),
        }
    }
}

impl IpcProcError {
    pub fn message(&self) -> &str {
        match self {
            Self::Failed { message }
            | Self::Unsupported { message }
            | Self::PermissionDenied { message }
            | Self::Rejected { message } => message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_error_exposes_message() {
        let error = failed_error("boom");

        assert_eq!(error.message(), "boom");
    }
}
