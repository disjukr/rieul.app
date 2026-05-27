pub const USER_PIPE_NAME: &str = r"\\.\pipe\wgo-user-active";

#[derive(Debug, Clone)]
pub struct UserDaemonRegistration {
    pub pipe_name: String,
    pub user_name: String,
    pub session_id: u32,
}

impl UserDaemonRegistration {
    pub fn active_user(user_name: impl Into<String>) -> Self {
        Self {
            pipe_name: USER_PIPE_NAME.to_string(),
            user_name: user_name.into(),
            session_id: 0,
        }
    }
}
