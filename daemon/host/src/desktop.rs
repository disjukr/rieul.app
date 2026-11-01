//! Desktop admission and input state machine. No OS capture/input is performed here.
//! Keep the work guard until teardown has released input and stopped capture.
use crate::maintenance::{WorkGate, WorkGuard};
use rieul_daemon_core::generated::rpc::{
    DesktopControlAction, DesktopInputEvent, DesktopInputFrame, DesktopKeyboardMode,
    DesktopViewport,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub const PROFILE: u64 = 1;
pub const MAX_FRAME: usize = 16 * 1024;
pub const MAX_STREAM: usize = 8 * 1024 * 1024;
pub const MAX_VIEWPORTS: usize = 8;
pub const LEASE_MS: u64 = 15_000;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Unauthorized,
    NotFound,
    Busy,
    Stale,
    Invalid,
    Unsupported,
    Limit,
    Backend,
}
/// The adapter must query the current credential store, including revocation/expiry.
pub trait Credentials {
    fn valid(&self, client: &str, now_ms: u64) -> bool;
}
/// Implementations must release every held key/button even if one release fails.
/// A failed release poisons the manager: a new controller cannot acquire it.
pub trait Input {
    fn send(&mut self, event: &DesktopInputEvent) -> Result<(), Error>;
}
struct Attachment {
    connection: u64,
    keyboard_mode: DesktopKeyboardMode,
    client: String,
    deadline: u64,
    sequence: u64,
    viewports: BTreeMap<String, DesktopViewport>,
    _work: WorkGuard,
}
pub struct Desktop<I> {
    gate: Arc<WorkGate>,
    input: I,
    attachments: BTreeMap<String, Attachment>,
    holder: Option<String>,
    epoch: u64,
    next_id: u64,
    layout_epoch: u64,
    keys: BTreeSet<u64>,
    buttons: BTreeSet<u64>,
    poisoned: bool,
}
impl<I: Input> Desktop<I> {
    pub fn new(gate: Arc<WorkGate>, input: I) -> Self {
        Self {
            gate,
            input,
            attachments: BTreeMap::new(),
            holder: None,
            epoch: 1,
            next_id: 0,
            layout_epoch: 1,
            keys: BTreeSet::new(),
            buttons: BTreeSet::new(),
            poisoned: false,
        }
    }
    pub fn control(&self) -> (Option<&str>, u64) {
        (self.holder.as_deref(), self.epoch)
    }
    pub fn attach(
        &mut self,
        auth: &impl Credentials,
        connection: u64,
        client: &str,
        keyboard_mode: DesktopKeyboardMode,
        now: u64,
    ) -> Result<String, Error> {
        self.expire(auth, now)?;
        if !auth.valid(client, now) {
            return Err(Error::Unauthorized);
        }
        if self.poisoned {
            return Err(Error::Backend);
        }
        if self.attachments.len() >= 16 {
            return Err(Error::Limit);
        }
        let work = self.gate.enter().ok_or(Error::Busy)?;
        self.next_id = self
            .next_id
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE)
            .ok_or(Error::Limit)?;
        // Connection binding, not secrecy of this ID, authorizes every operation.
        let id = format!("desktop-{}", self.next_id);
        self.attachments.insert(
            id.clone(),
            Attachment {
                connection,
                keyboard_mode,
                client: client.into(),
                deadline: now.saturating_add(LEASE_MS),
                sequence: 0,
                viewports: BTreeMap::new(),
                _work: work,
            },
        );
        Ok(id)
    }
    fn authorize(
        &mut self,
        auth: &impl Credentials,
        connection: u64,
        id: &str,
        now: u64,
    ) -> Result<(), Error> {
        self.expire(auth, now)?;
        let attach = self.attachments.get(id).ok_or(Error::NotFound)?;
        if attach.connection != connection {
            return Err(Error::Unauthorized);
        }
        if self.poisoned {
            return Err(Error::Backend);
        }
        Ok(())
    }
    fn release(&mut self) -> Result<(), Error> {
        self.holder = None;
        self.epoch = self
            .epoch
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE)
            .ok_or_else(|| {
                self.poisoned = true;
                Error::Limit
            })?;
        if self.input.send(&DesktopInputEvent::ReleaseAll).is_err() {
            self.poisoned = true;
            return Err(Error::Backend);
        }
        self.keys.clear();
        self.buttons.clear();
        Ok(())
    }
    pub fn expire(&mut self, auth: &impl Credentials, now: u64) -> Result<(), Error> {
        let dead: Vec<_> = self
            .attachments
            .iter()
            .filter(|(_, a)| now >= a.deadline || !auth.valid(&a.client, now))
            .map(|(id, _)| id.clone())
            .collect();
        for id in dead {
            self.remove(&id)?;
        }
        Ok(())
    }
    fn remove(&mut self, id: &str) -> Result<(), Error> {
        if self.poisoned {
            return Err(Error::Backend);
        }
        if self.holder.as_deref() == Some(id) {
            self.release()?;
        }
        // Failed release retains the guard, preventing updates over stuck input.
        self.attachments.remove(id);
        Ok(())
    }
    pub fn disconnect(&mut self, connection: u64) -> Result<(), Error> {
        let ids: Vec<_> = self
            .attachments
            .iter()
            .filter(|(_, a)| a.connection == connection)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.remove(&id)?;
        }
        Ok(())
    }
    pub fn detach(
        &mut self,
        auth: &impl Credentials,
        connection: u64,
        id: &str,
        now: u64,
    ) -> Result<(), Error> {
        self.authorize(auth, connection, id, now)?;
        self.remove(id)
    }
    pub fn renew(
        &mut self,
        auth: &impl Credentials,
        connection: u64,
        id: &str,
        now: u64,
    ) -> Result<(), Error> {
        self.authorize(auth, connection, id, now)?;
        self.attachments.get_mut(id).unwrap().deadline = now.saturating_add(LEASE_MS);
        Ok(())
    }
    pub fn set_control(
        &mut self,
        auth: &impl Credentials,
        connection: u64,
        id: &str,
        now: u64,
        action: DesktopControlAction,
    ) -> Result<(), Error> {
        self.authorize(auth, connection, id, now)?;
        match action {
            DesktopControlAction::Release => {
                if self.holder.as_deref() == Some(id) {
                    self.release()?;
                }
            }
            DesktopControlAction::Acquire | DesktopControlAction::Takeover => {
                if self.holder.as_deref() == Some(id) {
                    return Ok(());
                }
                if self.holder.is_some() && action == DesktopControlAction::Acquire {
                    return Err(Error::Busy);
                }
                self.release()?;
                self.holder = Some(id.into());
            }
        }
        Ok(())
    }
    /// Call only after the capture adapter has validated displays/crops and codecs.
    /// Width/height are viewport coordinates; the adapter maps them to crop pixels.
    pub fn configure(
        &mut self,
        auth: &impl Credentials,
        connection: u64,
        id: &str,
        now: u64,
        epoch: u64,
        viewports: Vec<DesktopViewport>,
        budget: u64,
    ) -> Result<(), Error> {
        self.authorize(auth, connection, id, now)?;
        if epoch != self.layout_epoch {
            return Err(Error::Stale);
        }
        if viewports.len() > MAX_VIEWPORTS || budget == 0 || budget > 100_000_000 {
            return Err(Error::Limit);
        }
        let mut next = BTreeMap::new();
        let mut total = 0u64;
        for v in viewports {
            if v.viewport_id.is_empty()
                || v.viewport_id.len() > 128
                || v.display_id.len() > 128
                || v.width == 0
                || v.height == 0
                || v.width > 8192
                || v.height > 8192
                || v.fps == 0
                || v.fps > 120
                || v.bitrate == 0
                || v.crop.width == 0
                || v.crop.height == 0
            {
                return Err(Error::Invalid);
            }
            total = total.checked_add(v.bitrate).ok_or(Error::Limit)?;
            if next.insert(v.viewport_id.clone(), v).is_some() {
                return Err(Error::Invalid);
            }
        }
        if total > budget {
            return Err(Error::Limit);
        }
        self.attachments.get_mut(id).unwrap().viewports = next;
        Ok(())
    }
    pub fn layout_changed(&mut self) -> Result<(), Error> {
        self.layout_epoch = self
            .layout_epoch
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE)
            .ok_or(Error::Limit)?;
        for a in self.attachments.values_mut() {
            a.viewports.clear();
        }
        Ok(())
    }
    pub fn input(
        &mut self,
        auth: &impl Credentials,
        connection: u64,
        now: u64,
        frame: DesktopInputFrame,
    ) -> Result<(), Error> {
        self.authorize(auth, connection, &frame.attach_id, now)?;
        if self.holder.as_deref() != Some(&frame.attach_id) || frame.input_epoch != self.epoch {
            return Err(Error::Stale);
        }
        let a = self.attachments.get_mut(&frame.attach_id).unwrap();
        if frame.sequence != a.sequence + 1 || frame.sequence > MAX_SAFE {
            return Err(Error::Stale);
        }
        // Consume rejected geometry too: a later release must still be deliverable.
        a.sequence = frame.sequence;
        let event = &frame.event;
        let point = match event {
            DesktopInputEvent::AbsolutePointer { viewport_id, x, y }
            | DesktopInputEvent::Button {
                viewport_id,
                x,
                y,
                down: true,
                ..
            }
            | DesktopInputEvent::Wheel {
                viewport_id, x, y, ..
            } => Some((viewport_id, x, y)),
            _ => None,
        };
        if let Some((id, x, y)) = point {
            if frame.layout_epoch != self.layout_epoch {
                return Err(Error::Stale);
            }
            let v = a.viewports.get(id).ok_or(Error::Invalid)?;
            if !x.is_finite()
                || !y.is_finite()
                || *x < 0.0
                || *y < 0.0
                || *x >= v.width as f64
                || *y >= v.height as f64
            {
                return Err(Error::Invalid);
            }
        }
        match event {
            DesktopInputEvent::PhysicalKey {
                usage,
                down,
                repeat,
            } => {
                // USB HID keyboard page: includes distinct left/right modifiers and keypad.
                if (a.keyboard_mode == DesktopKeyboardMode::Text && !(224..=231).contains(usage))
                    || !(4..=231).contains(usage)
                    || (*repeat && (!down || !self.keys.contains(usage)))
                {
                    return Err(Error::Invalid);
                }
                if *down {
                    self.keys.insert(*usage);
                } else {
                    self.keys.remove(usage);
                }
            }
            DesktopInputEvent::Button { button, down, .. } => {
                if !(1..=5).contains(button) {
                    return Err(Error::Invalid);
                }
                if *down {
                    self.buttons.insert(*button);
                } else {
                    self.buttons.remove(button);
                }
            }
            DesktopInputEvent::TextCommit { text } => {
                if a.keyboard_mode != DesktopKeyboardMode::Text
                    || text.len() > 4096
                    || text.contains('\0')
                    || !self.keys.is_empty()
                {
                    return Err(Error::Invalid);
                }
            }
            DesktopInputEvent::Composition { .. } | DesktopInputEvent::RelativePointer { .. } => {
                return Err(Error::Unsupported)
            }
            DesktopInputEvent::Wheel { dx, dy, .. }
                if !dx.is_finite()
                    || !dy.is_finite()
                    || dx.abs() > 100_000.0
                    || dy.abs() > 100_000.0 =>
            {
                return Err(Error::Invalid)
            }
            DesktopInputEvent::Feedback { .. } => return Err(Error::Unsupported),
            DesktopInputEvent::ReleaseAll => {
                self.keys.clear();
                self.buttons.clear();
            }
            _ => {}
        }
        if self.input.send(event).is_err() {
            let _ = self.release();
            return Err(Error::Backend);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    struct Auth(Cell<bool>);
    impl Credentials for Auth {
        fn valid(&self, client: &str, now: u64) -> bool {
            self.0.get() && client == "paired" && now < 30_000
        }
    }
    #[derive(Default)]
    struct FakeInput {
        events: Vec<DesktopInputEvent>,
        fail: bool,
    }
    impl Input for FakeInput {
        fn send(&mut self, e: &DesktopInputEvent) -> Result<(), Error> {
            if self.fail {
                Err(Error::Backend)
            } else {
                self.events.push(e.clone());
                Ok(())
            }
        }
    }
    fn setup() -> (Desktop<FakeInput>, Auth, String) {
        let mut d = Desktop::new(Arc::new(WorkGate::default()), FakeInput::default());
        let auth = Auth(Cell::new(true));
        let id = d
            .attach(&auth, 1, "paired", DesktopKeyboardMode::Physical, 0)
            .unwrap();
        d.set_control(&auth, 1, &id, 0, DesktopControlAction::Acquire)
            .unwrap();
        (d, auth, id)
    }
    fn frame(
        d: &Desktop<FakeInput>,
        id: &str,
        seq: u64,
        event: DesktopInputEvent,
    ) -> DesktopInputFrame {
        DesktopInputFrame {
            attach_id: id.into(),
            input_epoch: d.epoch,
            sequence: seq,
            layout_epoch: d.layout_epoch,
            event,
        }
    }
    fn key(down: bool) -> DesktopInputEvent {
        DesktopInputEvent::PhysicalKey {
            usage: 225,
            down,
            repeat: false,
        }
    }
    #[test]
    fn attach_does_not_steal_control_and_takeover_releases_first() {
        let (mut d, auth, id) = setup();
        d.input(&auth, 1, 1, frame(&d, &id, 1, key(true))).unwrap();
        let old_epoch = d.epoch;
        let second = d
            .attach(&auth, 2, "paired", DesktopKeyboardMode::Physical, 2)
            .unwrap();
        assert_eq!(d.holder.as_deref(), Some(id.as_str()));
        assert_eq!(
            d.set_control(&auth, 2, &second, 2, DesktopControlAction::Acquire),
            Err(Error::Busy)
        );
        d.set_control(&auth, 2, &second, 2, DesktopControlAction::Takeover)
            .unwrap();
        assert!(d.epoch > old_epoch);
        assert!(d.keys.is_empty());
        assert_eq!(d.input.events.last(), Some(&DesktopInputEvent::ReleaseAll));
        assert_eq!(
            d.input(&auth, 1, 3, frame(&d, &id, 2, key(true))),
            Err(Error::Stale)
        );
    }
    #[test]
    fn revoked_expired_unpaired_and_wrong_connection_are_rejected() {
        let (mut d, auth, id) = setup();
        assert_eq!(
            d.attach(&auth, 8, "unknown", DesktopKeyboardMode::Physical, 0),
            Err(Error::Unauthorized)
        );
        assert_eq!(
            d.input(&auth, 2, 0, frame(&d, &id, 1, key(true))),
            Err(Error::Unauthorized)
        );
        auth.0.set(false);
        assert_eq!(
            d.input(&auth, 1, 0, frame(&d, &id, 1, key(true))),
            Err(Error::NotFound)
        );
        assert!(d.holder.is_none());
        assert_eq!(d.gate.active(), 0);
        auth.0.set(true);
        let next = d
            .attach(&auth, 1, "paired", DesktopKeyboardMode::Physical, 20_000)
            .unwrap();
        assert_ne!(next, id);
        assert_eq!(d.renew(&auth, 1, &next, 30_000), Err(Error::NotFound));
    }
    #[test]
    fn stale_geometry_does_not_block_key_up_or_release() {
        let (mut d, auth, id) = setup();
        d.input(&auth, 1, 0, frame(&d, &id, 1, key(true))).unwrap();
        let mut up = frame(&d, &id, 3, key(false));
        let motion = frame(
            &d,
            &id,
            2,
            DesktopInputEvent::AbsolutePointer {
                viewport_id: "v".into(),
                x: 10.0,
                y: 10.0,
            },
        );
        d.layout_changed().unwrap();
        assert_eq!(d.input(&auth, 1, 0, motion), Err(Error::Stale));
        up.layout_epoch = 1;
        d.input(&auth, 1, 0, up).unwrap();
        assert!(d.keys.is_empty());
    }
    #[test]
    fn lease_disconnect_and_reconnect_never_restore_control() {
        let (mut d, auth, id) = setup();
        let replay = frame(&d, &id, 1, key(true));
        d.input(&auth, 1, 0, replay.clone()).unwrap();
        assert_eq!(d.input(&auth, 1, 0, replay.clone()), Err(Error::Stale));
        d.expire(&auth, LEASE_MS).unwrap();
        assert!(d.holder.is_none());
        let next = d
            .attach(&auth, 3, "paired", DesktopKeyboardMode::Physical, LEASE_MS)
            .unwrap();
        assert_ne!(id, next);
        assert!(d.holder.is_none());
        assert_eq!(d.input(&auth, 3, LEASE_MS, replay), Err(Error::NotFound));
        d.disconnect(3).unwrap();
        assert_eq!(d.gate.active(), 0);
    }
    #[test]
    fn failed_release_prevents_takeover_and_update() {
        let (mut d, auth, id) = setup();
        let second = d
            .attach(&auth, 2, "paired", DesktopKeyboardMode::Physical, 0)
            .unwrap();
        d.input.fail = true;
        assert_eq!(
            d.set_control(&auth, 2, &second, 0, DesktopControlAction::Takeover),
            Err(Error::Backend)
        );
        assert!(d.gate.begin_drain().is_none());
        assert_eq!(d.detach(&auth, 1, &id, 0), Err(Error::Backend));
        assert_eq!(d.expire(&auth, LEASE_MS), Err(Error::Backend));
        assert!(d.gate.begin_drain().is_none());
    }
    #[test]
    fn active_viewer_blocks_manual_and_automatic_drain_atomically() {
        let (mut d, auth, id) = setup();
        assert!(d.gate.begin_drain().is_none());
        d.detach(&auth, 1, &id, 0).unwrap();
        let drain = d.gate.begin_drain().unwrap();
        assert_eq!(
            d.attach(&auth, 1, "paired", DesktopKeyboardMode::Physical, 0),
            Err(Error::Busy)
        );
        drop(drain);
        assert!(d
            .attach(&auth, 1, "paired", DesktopKeyboardMode::Physical, 0)
            .is_ok());
    }
    #[test]
    fn physical_and_text_cannot_double_inject() {
        let (mut d, auth, id) = setup();
        d.input(&auth, 1, 0, frame(&d, &id, 1, key(true))).unwrap();
        assert_eq!(
            d.input(
                &auth,
                1,
                0,
                frame(
                    &d,
                    &id,
                    2,
                    DesktopInputEvent::TextCommit { text: "A".into() }
                )
            ),
            Err(Error::Invalid)
        );
        d.input(&auth, 1, 0, frame(&d, &id, 3, key(false))).unwrap();
        d.attachments.get_mut(&id).unwrap().keyboard_mode = DesktopKeyboardMode::Text;
        d.input(
            &auth,
            1,
            0,
            frame(
                &d,
                &id,
                4,
                DesktopInputEvent::TextCommit { text: "가".into() },
            ),
        )
        .unwrap();
    }
}

/// Enforced before decoding each input payload. The caller closes a stream at
/// MAX_STREAM, then opens its successor after the receipt; attachment sequence
/// continues across rollover. Never concatenate the lifetime of an input stream.
#[derive(Default)]
pub struct InputStreamBudget {
    bytes: usize,
    failed: bool,
}
impl InputStreamBudget {
    pub fn decode(&mut self, payload: &[u8]) -> Result<DesktopInputFrame, Error> {
        if self.failed {
            return Err(Error::Invalid);
        }
        let result = (|| {
            if payload.is_empty() || payload.len() > MAX_FRAME {
                return Err(Error::Limit);
            }
            self.bytes = self.bytes.checked_add(payload.len()).ok_or(Error::Limit)?;
            if self.bytes > MAX_STREAM {
                return Err(Error::Limit);
            }
            DesktopInputFrame::decode(payload).map_err(|_| Error::Invalid)
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}
#[cfg(test)]
mod bounds_tests {
    use super::*;
    #[test]
    fn input_bounds_fail_closed_and_rollover_resets_only_bytes() {
        let f = DesktopInputFrame {
            attach_id: "a".into(),
            input_epoch: 1,
            sequence: 7,
            layout_epoch: 1,
            event: DesktopInputEvent::ReleaseAll,
        };
        let b = f.encode();
        let mut budget = InputStreamBudget::default();
        assert_eq!(budget.decode(&b).unwrap(), f);
        budget.bytes = MAX_STREAM;
        assert_eq!(budget.decode(&b), Err(Error::Limit));
        assert_eq!(budget.decode(&b), Err(Error::Invalid));
        assert_eq!(InputStreamBudget::default().decode(&b).unwrap().sequence, 7);
        assert_eq!(
            InputStreamBudget::default().decode(&vec![0; MAX_FRAME + 1]),
            Err(Error::Limit)
        );
    }
    #[test]
    fn admission_and_drain_have_no_check_then_act_race() {
        for _ in 0..32 {
            let gate = Arc::new(WorkGate::default());
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let g = gate.clone();
            let b = barrier.clone();
            let work = std::thread::spawn(move || {
                let guard = g.enter();
                b.wait();
                let entered = guard.is_some();
                b.wait();
                entered
            });
            let drain = gate.begin_drain();
            barrier.wait();
            let entered = drain.is_some();
            barrier.wait();
            assert_ne!(work.join().unwrap(), entered);
        }
    }
}

#[cfg(test)]
mod viewport_tests {
    use super::*;
    struct Auth;
    impl Credentials for Auth {
        fn valid(&self, _: &str, _: u64) -> bool {
            true
        }
    }
    struct Sink;
    impl Input for Sink {
        fn send(&mut self, _: &DesktopInputEvent) -> Result<(), Error> {
            Ok(())
        }
    }
    #[test]
    fn viewport_limits_are_atomic_and_coordinates_finite() {
        let mut d = Desktop::new(Arc::new(WorkGate::default()), Sink);
        let id = d
            .attach(&Auth, 1, "paired", DesktopKeyboardMode::Physical, 0)
            .unwrap();
        d.set_control(&Auth, 1, &id, 0, DesktopControlAction::Acquire)
            .unwrap();
        let v = DesktopViewport {
            viewport_id: "left".into(),
            display_id: "d".into(),
            crop: rieul_daemon_core::generated::rpc::DesktopRect {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
            width: 100,
            height: 100,
            fps: 60,
            bitrate: 1_000_000,
        };
        d.configure(&Auth, 1, &id, 0, 1, vec![v.clone()], 1_000_000)
            .unwrap();
        assert_eq!(
            d.configure(&Auth, 1, &id, 0, 1, vec![v.clone(), v], 1_000_000),
            Err(Error::Invalid)
        );
        assert_eq!(d.attachments[&id].viewports.len(), 1);
        for (i, x) in [f64::NAN, f64::INFINITY, -1.0, 100.0].iter().enumerate() {
            assert_eq!(
                d.input(
                    &Auth,
                    1,
                    0,
                    DesktopInputFrame {
                        attach_id: id.clone(),
                        input_epoch: d.epoch,
                        sequence: i as u64 + 1,
                        layout_epoch: 1,
                        event: DesktopInputEvent::AbsolutePointer {
                            viewport_id: "left".into(),
                            x: *x,
                            y: 0.0
                        }
                    }
                ),
                Err(Error::Invalid)
            );
        }
        d.input(
            &Auth,
            1,
            0,
            DesktopInputFrame {
                attach_id: id,
                input_epoch: d.epoch,
                sequence: 5,
                layout_epoch: 0,
                event: DesktopInputEvent::Button {
                    viewport_id: "gone".into(),
                    x: 0.0,
                    y: 0.0,
                    button: 1,
                    down: false,
                },
            },
        )
        .unwrap();
    }
}
