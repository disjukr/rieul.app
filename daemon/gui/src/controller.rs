//! Toolkit-independent pairing lifecycle. A pending request owns exactly one reply.
use anyhow::{Result, bail, ensure};
use rand::{Rng, seq::SliceRandom};
use rieul_daemon_core::{
    cbor::Value,
    ipc::{self, ConfirmPairingReq, RpcRequest, ShowPairingCodeReq},
};
use tokio::sync::oneshot;

#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub config_path: String,
    pub daemon_url: String,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Route {
    Idle(Info),
    Info(Info),
    Code(ShowPairingCodeReq),
    Confirm {
        model: ConfirmPairingReq,
        candidates: [String; 4],
    },
}
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Show,
    Hide,
    Title(&'static str),
    Notify {
        generation: u64,
        title: String,
        body: String,
    },
}
pub type Reply = oneshot::Sender<Result<Option<Vec<u8>>>>;
struct Pending {
    connection: u64,
    reply: Reply,
}
pub struct Controller {
    pub info: Info,
    pub route: Route,
    pub generation: u64,
    pending: Option<Pending>,
    disposed: bool,
}
impl Controller {
    pub fn new(info: Info) -> Self {
        Self {
            route: Route::Idle(info.clone()),
            info,
            generation: 0,
            pending: None,
            disposed: false,
        }
    }
    fn alive(&self) -> Result<()> {
        ensure!(!self.disposed, "pairing utility disposed");
        Ok(())
    }
    fn settle(&mut self, accepted: bool) {
        if let Some(pending) = self.pending.take() {
            let payload = ipc::ConfirmPairingRes { accepted }.encode();
            let _ = pending.reply.send(Ok(Some(payload)));
        }
    }
    fn route(&mut self, route: Route) -> Effect {
        let title = match route {
            Route::Code(_) => "Pairing code",
            Route::Confirm { .. } => "Confirm pairing",
            _ => "Daemon info",
        };
        self.route = route;
        self.generation += 1;
        Effect::Title(title)
    }
    pub fn show_info(&mut self, info: Info) -> Result<Vec<Effect>> {
        self.alive()?;
        self.settle(false);
        Ok(vec![self.route(Route::Info(info)), Effect::Show])
    }
    pub fn activate(&self) -> Result<Vec<Effect>> {
        self.alive()?;
        Ok(vec![Effect::Show])
    }
    pub fn close(&mut self) -> Vec<Effect> {
        if self.disposed {
            return vec![];
        }
        let mut effects = vec![];
        if matches!(self.route, Route::Confirm { .. }) {
            self.settle(false);
            effects.push(self.route(Route::Idle(self.info.clone())));
        }
        effects.push(Effect::Hide);
        effects
    }
    pub fn resolve(&mut self, accepted: bool, generation: u64) -> Result<()> {
        self.alive()?;
        ensure!(
            self.pending.is_some() && generation == self.generation,
            "no matching pairing confirmation is pending"
        );
        self.settle(accepted);
        Ok(())
    }
    pub fn disconnected(&mut self, connection: u64) -> Vec<Effect> {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.connection == connection)
        {
            self.close()
        } else {
            vec![]
        }
    }
    pub fn notification_result(&self, generation: u64, shown: bool) -> Vec<Effect> {
        if !shown && !self.disposed && self.pending.is_some() && generation == self.generation {
            vec![Effect::Show]
        } else {
            vec![]
        }
    }
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.settle(false);
    }
    /// Validation must finish before replacing/rejecting any live confirmation.
    pub fn request(
        &mut self,
        proc_id: u64,
        payload: &[u8],
        connection: u64,
        reply: Reply,
    ) -> Vec<Effect> {
        let decoded = self.alive().and_then(|_| validate(proc_id, payload));
        let request = match decoded {
            Ok(request) => request,
            Err(error) => {
                let _ = reply.send(Err(error));
                return vec![];
            }
        };
        let effects = match request {
            RpcRequest::ConfirmPairing(model) => {
                self.settle(false);
                let mut rng = rand::rng();
                let mut values = vec![model.confirmation_code.clone()];
                while values.len() < 4 {
                    let next = format!("{:02}", rng.random_range(0..100));
                    if !values.contains(&next) {
                        values.push(next);
                    }
                }
                values.shuffle(&mut rng);
                let body = format!(
                    "{} wants to connect.",
                    if model.client_label.trim().is_empty() {
                        "Unknown client"
                    } else {
                        model.client_label.trim()
                    }
                );
                self.pending = Some(Pending { connection, reply });
                let title = self.route(Route::Confirm {
                    model,
                    candidates: values.try_into().unwrap(),
                });
                return vec![
                    title,
                    Effect::Notify {
                        generation: self.generation,
                        title: "Pairing requested".into(),
                        body,
                    },
                ];
            }
            RpcRequest::ShowPairingCode(model) => {
                self.settle(false);
                vec![self.route(Route::Code(model))]
            }
            RpcRequest::ShowDaemonInfo(model) => {
                let info = Info {
                    config_path: if model.config_path.is_empty() {
                        self.info.config_path.clone()
                    } else {
                        model.config_path
                    },
                    daemon_url: if model.daemon_url.is_empty() {
                        self.info.daemon_url.clone()
                    } else {
                        model.daemon_url
                    },
                };
                self.show_info(info).unwrap()
            }
            RpcRequest::ActivateGui(_) => vec![Effect::Show],
            RpcRequest::PairingCompleted(_) => {
                if matches!(self.route, Route::Code(_)) {
                    vec![self.route(Route::Idle(self.info.clone())), Effect::Hide]
                } else {
                    vec![]
                }
            }
            _ => unreachable!("validated GUI request"),
        };
        let _ = reply.send(Ok(None));
        effects
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        self.dispose();
    }
}

pub fn validate(proc_id: u64, payload: &[u8]) -> Result<RpcRequest> {
    let required = match proc_id {
        1 | 2 => 3,
        3 => 2,
        4 => 1,
        6 => 0,
        _ => bail!("unsupported GUI IPC proc id {proc_id}"),
    };
    if required == 0 {
        ensure!(
            payload.is_empty(),
            "PairingCompleted requires a void payload"
        );
    } else {
        let Value::Map(fields) = Value::decode(payload)? else {
            bail!("GUI request must be a CBOR map");
        };
        for id in 1..=required {
            if proc_id == 1 && id == 3 {
                ensure!(
                    matches!(fields.get(&id), Some(Value::U64(n)) if *n <= 9_007_199_254_740_991),
                    "expiresInSeconds must be u53"
                );
            } else {
                ensure!(
                    matches!(fields.get(&id), Some(Value::Text(_))),
                    "required GUI field {id} must be text"
                );
            }
        }
        let text = |id| match &fields[&id] {
            Value::Text(s) => s.as_str(),
            _ => unreachable!(),
        };
        if proc_id == 1 || proc_id == 2 {
            validate_url(text(1))?;
            let code = text(2);
            ensure!(
                code.len() == if proc_id == 1 { 6 } else { 2 }
                    && code.bytes().all(|b| b.is_ascii_digit()),
                "invalid pairing code"
            );
        } else if proc_id == 3 && !text(2).is_empty() {
            validate_url(text(2))?;
        }
    }
    RpcRequest::decode(
        proc_id,
        if payload.is_empty() {
            None
        } else {
            Some(payload)
        },
    )
    .map_err(|e| anyhow::anyhow!("{e:?}"))
}
fn validate_url(value: &str) -> Result<()> {
    ensure!(
        value
            .get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
            && !value.chars().any(|c| c <= ' ' || c == '\u{7f}'),
        "daemonUrl must be an absolute HTTPS URL"
    );
    let url = url::Url::parse(value)?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "daemonUrl must be HTTPS without userinfo"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    fn fixture() -> Controller {
        Controller::new(Info {
            config_path: "fixture.yaml".into(),
            daemon_url: "https://fixture.invalid:9012".into(),
        })
    }
    fn confirmation(
        controller: &mut Controller,
        connection: u64,
        code: &str,
    ) -> oneshot::Receiver<Result<Option<Vec<u8>>>> {
        let (tx, rx) = oneshot::channel();
        let payload = ConfirmPairingReq {
            daemon_url: controller.info.daemon_url.clone(),
            confirmation_code: code.into(),
            client_label: "Fixture".into(),
        }
        .encode();
        controller.request(2, &payload, connection, tx);
        rx
    }
    fn accepted(mut rx: oneshot::Receiver<Result<Option<Vec<u8>>>>) -> bool {
        ipc::ConfirmPairingRes::decode(&rx.try_recv().unwrap().unwrap().unwrap())
            .unwrap()
            .accepted
    }
    #[test]
    fn replacement_stale_response_and_late_disconnect_are_isolated() {
        let mut c = fixture();
        let first = confirmation(&mut c, 1, "42");
        let generation = c.generation;
        let second = confirmation(&mut c, 2, "73");
        assert!(!accepted(first));
        assert!(c.resolve(true, generation).is_err());
        assert!(c.disconnected(1).is_empty());
        assert!(c.notification_result(generation, false).is_empty());
        c.resolve(true, c.generation).unwrap();
        assert!(accepted(second));
        assert!(c.resolve(true, c.generation).is_err());
    }
    #[test]
    fn close_disconnect_dispose_and_drop_reject_once() {
        for mode in 0..4 {
            let mut c = fixture();
            let rx = confirmation(&mut c, 10, "00");
            match mode {
                0 => {
                    assert!(c.close().contains(&Effect::Hide));
                    assert!(matches!(c.route, Route::Idle(_)));
                }
                1 => {
                    assert!(c.disconnected(10).contains(&Effect::Hide));
                }
                2 => {
                    c.dispose();
                    c.dispose();
                    assert!(c.activate().is_err());
                }
                _ => {
                    drop(c);
                }
            }
            assert!(!accepted(rx));
        }
    }
    #[test]
    fn malformed_requests_never_cancel_live_confirmation() {
        let mut c = fixture();
        let mut pending = confirmation(&mut c, 1, "42");
        let generation = c.generation;
        let bases: Vec<(u64, BTreeMap<u64, Value>)> = vec![
            (
                1,
                [
                    (1, Value::Text(c.info.daemon_url.clone())),
                    (2, Value::Text("123456".into())),
                    (3, Value::U64(30)),
                ]
                .into(),
            ),
            (
                2,
                [
                    (1, Value::Text(c.info.daemon_url.clone())),
                    (2, Value::Text("42".into())),
                    (3, Value::Text("Fixture".into())),
                ]
                .into(),
            ),
            (
                3,
                [(1, Value::Text("".into())), (2, Value::Text("".into()))].into(),
            ),
            (4, [(1, Value::Text("".into()))].into()),
        ];
        for (proc_id, base) in bases {
            for key in base.keys() {
                let mut variants = vec![];
                let mut missing = base.clone();
                missing.remove(key);
                variants.push(missing);
                for value in [
                    Value::Null,
                    Value::Bool(false),
                    Value::Array(vec![]),
                    Value::Bytes(vec![1]),
                    Value::Map(BTreeMap::new()),
                    Value::F64(1.5),
                ] {
                    let mut wrong = base.clone();
                    wrong.insert(*key, value);
                    variants.push(wrong);
                }
                for map in variants {
                    let (tx, mut rx) = oneshot::channel();
                    assert!(
                        c.request(proc_id, &Value::Map(map).encode(), 2, tx)
                            .is_empty()
                    );
                    assert!(rx.try_recv().unwrap().is_err());
                    assert_eq!(c.generation, generation);
                    assert!(pending.try_recv().is_err());
                }
            }
        }
        c.close();
        assert!(!accepted(pending));
    }
    #[test]
    fn semantic_invalid_values_and_unknown_fields() {
        for value in [
            "",
            "https:fixture.invalid",
            "http://fixture.invalid",
            "https://",
            "https://u:p@fixture.invalid",
            "https://fixture.invalid/line\nbreak",
        ] {
            assert!(validate_url(value).is_err());
        }
        for code in ["", "1", "４２", "42\n", "123"] {
            assert!(
                validate(
                    2,
                    &ConfirmPairingReq {
                        daemon_url: "https://fixture.invalid".into(),
                        confirmation_code: code.into(),
                        client_label: "".into()
                    }
                    .encode()
                )
                .is_err()
            );
        }
        for ttl in [0, 9_007_199_254_740_991] {
            let req = ShowPairingCodeReq {
                daemon_url: "https://[::1]:9012/base?x=1".into(),
                pairing_code: "000000".into(),
                expires_in_seconds: ttl,
            };
            let Value::Map(mut map) = Value::decode(&req.encode()).unwrap() else {
                panic!()
            };
            map.insert(99, Value::Array(vec![Value::Null]));
            assert!(validate(1, &Value::Map(map).encode()).is_ok());
        }
    }
    #[test]
    fn candidates_notification_and_completion_preserve_lifecycle() {
        let mut c = fixture();
        for n in 0..100 {
            let code = format!("{n:02}");
            let rx = confirmation(&mut c, n, &code);
            let Route::Confirm { candidates, .. } = &c.route else {
                panic!()
            };
            assert!(candidates.contains(&code));
            assert_eq!(
                candidates
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len(),
                4
            );
            assert_eq!(
                c.notification_result(c.generation, false),
                vec![Effect::Show]
            );
            assert!(c.notification_result(c.generation, true).is_empty());
            c.show_info(c.info.clone()).unwrap();
            assert!(!accepted(rx));
        }
        let (tx, _) = oneshot::channel();
        let code = ShowPairingCodeReq {
            daemon_url: c.info.daemon_url.clone(),
            pairing_code: "123456".into(),
            expires_in_seconds: 30,
        };
        let effects = c.request(1, &code.encode(), 1, tx);
        assert!(!effects.contains(&Effect::Show));
        let (tx, _) = oneshot::channel();
        assert!(c.request(6, &[], 1, tx).contains(&Effect::Hide));
        assert!(matches!(c.route, Route::Idle(_)));
    }
}
