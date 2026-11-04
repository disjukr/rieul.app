//! Rieul hardware adaptation of voxl video::build job/return worker lifetime.
//! A bounded per-display thread. Native capture/COM objects are constructed and
//! dropped on that thread; only encoded frames cross it. No input work runs here.
use crate::desktop::{EncodedFrame as Frame, Error};
use std::sync::mpsc::{self, Receiver, SyncSender};
/// Keep a low-fps group below the helper request deadline; never sleep after its last frame.
pub fn group_frames(fps: u64) -> usize {
    fps.clamp(1, 60) as usize
}
type Reply = Result<Option<Frame>, Error>;
pub struct Worker {
    sender: Option<SyncSender<(bool, u64, SyncSender<Reply>)>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Worker {
    pub fn new<F, P>(create: F) -> Result<Self, Error>
    where
        F: FnOnce() -> Result<P, Error> + Send + 'static,
        P: FnMut(bool, u64, &mut dyn FnMut(Frame) -> Result<(), Error>) -> Result<(), Error>
            + 'static,
    {
        let (sender, requests) = mpsc::sync_channel::<(bool, u64, SyncSender<Reply>)>(1);
        let thread = std::thread::Builder::new()
            .name("rieul-voxl-display".into())
            .spawn(move || {
                // P deliberately need not be Send: e.g. COM apartment-affine capture.
                let mut producer = match create() {
                    Ok(p) => p,
                    Err(error) => {
                        if let Ok((_, _, reply)) = requests.recv() {
                            let _ = reply.send(Err(error));
                        }
                        return;
                    }
                };
                while let Ok((refresh, bitrate, reply)) = requests.recv() {
                    let result = producer(refresh, bitrate, &mut |frame| {
                        reply.send(Ok(Some(frame))).map_err(|_| Error::Stale)
                    });
                    let _ = reply.send(result.map(|_| None));
                }
            })
            .map_err(|_| Error::Backend)?;
        Ok(Self {
            sender: Some(sender),
            thread: Some(thread),
        })
    }
    pub fn group(
        &self,
        refresh: bool,
        emit: &mut dyn FnMut(Frame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.group_at_rate(refresh, 1, emit)
    }
    pub fn group_at_rate(
        &self,
        refresh: bool,
        bitrate: u64,
        emit: &mut dyn FnMut(Frame) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let (sender, receiver): (_, Receiver<Reply>) = mpsc::sync_channel(2);
        self.sender
            .as_ref()
            .ok_or(Error::Backend)?
            .try_send((refresh, bitrate, sender))
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::Backend,
            })?;
        let mut cancelled = None;
        loop {
            match receiver.recv().map_err(|_| Error::Backend)?? {
                Some(frame) if cancelled.is_none() => cancelled = emit(frame).err(),
                Some(_) => (),
                None => return cancelled.map_or(Ok(()), Err),
            }
            // Keep receiving to completion even if the consumer cancels. Do not
            // release capture/update ownership while encoding is still running.
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        drop(self.sender.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    #[test]
    fn rate_and_refresh_are_bound_to_each_worker_request() {
        let worker = Worker::new(|| {
            Ok(
                |refresh: bool, bitrate: u64, emit: &mut dyn FnMut(Frame) -> Result<(), Error>| {
                    emit(Frame::new(bitrate, refresh, vec![1]))
                },
            )
        })
        .unwrap();
        for (refresh, rate) in [(false, 2_000_000), (true, 500_000), (false, 2_000_000)] {
            worker
                .group_at_rate(refresh, rate, &mut |frame| {
                    assert_eq!(frame.timestamp_micros, rate);
                    assert_eq!(frame.keyframe, refresh);
                    Ok(())
                })
                .unwrap();
        }
    }
    #[test]
    fn exited_producer_is_fatal_not_permanent_backpressure() {
        type Producer =
            fn(bool, u64, &mut dyn FnMut(Frame) -> Result<(), Error>) -> Result<(), Error>;
        let (tx, rx) = mpsc::channel();
        let worker = Worker::new(move || -> Result<Producer, Error> {
            tx.send(()).unwrap();
            panic!("synthetic producer exit")
        })
        .unwrap();
        rx.recv().unwrap();
        assert_eq!(worker.group(false, &mut |_| Ok(())), Err(Error::Backend));
        assert_eq!(worker.group(false, &mut |_| Ok(())), Err(Error::Backend));
    }
    #[test]
    fn one_fps_group_finishes_without_a_frame_interval_sleep() {
        let worker = Worker::new(|| {
            Ok(
                |_refresh: bool,
                 _bitrate: u64,
                 emit: &mut dyn FnMut(Frame) -> Result<(), Error>| {
                    let count = group_frames(1);
                    for i in 0..count {
                        emit(Frame::new(i as u64, i == 0, vec![1]))?;
                        if i + 1 < count {
                            std::thread::sleep(std::time::Duration::from_secs(1));
                        }
                    }
                    Ok(())
                },
            )
        })
        .unwrap();
        let (tx, rx) = mpsc::channel();
        let thread =
            std::thread::spawn(move || tx.send(worker.group(false, &mut |_| Ok(()))).unwrap());
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_millis(500))
                .unwrap(),
            Ok(())
        );
        thread.join().unwrap();
        assert_eq!(group_frames(2), 2);
        assert_eq!(group_frames(120), 60);
    }
    #[test]
    fn independent_workers_cancel_and_drop_on_owner_thread() {
        let (pause, release) = mpsc::channel();
        let (seen, first) = mpsc::channel();
        let dropped = Arc::new(AtomicBool::new(false));
        let d = dropped.clone();
        let worker = Worker::new(move || {
            struct Owner(std::thread::ThreadId, Arc<AtomicBool>);
            impl Drop for Owner {
                fn drop(&mut self) {
                    assert_eq!(self.0, std::thread::current().id());
                    self.1.store(true, Ordering::SeqCst);
                }
            }
            let owner = std::rc::Rc::new(Owner(std::thread::current().id(), d));
            Ok(
                move |_refresh: bool,
                      _bitrate: u64,
                      emit: &mut dyn FnMut(Frame) -> Result<(), Error>| {
                    let owner = &owner;
                    assert_eq!(owner.0, std::thread::current().id());
                    emit(Frame {
                        timestamp_micros: 1,
                        data: vec![1],
                        keyframe: true,
                    })?;
                    seen.send(()).unwrap();
                    release.recv().unwrap();
                    Ok(())
                },
            )
        })
        .unwrap();
        let running = std::thread::spawn(move || {
            let result = worker.group(false, &mut |_| Err(Error::Stale));
            drop(worker);
            result
        });
        first
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert!(!running.is_finished());
        assert!(!dropped.load(Ordering::SeqCst));
        let other = Worker::new(|| {
            Ok(
                |_refresh: bool,
                 _bitrate: u64,
                 emit: &mut dyn FnMut(Frame) -> Result<(), Error>| {
                    emit(Frame {
                        timestamp_micros: 1,
                        data: vec![2],
                        keyframe: true,
                    })
                },
            )
        })
        .unwrap();
        let mut frames = 0;
        other
            .group(false, &mut |f| {
                assert_eq!(f.data, vec![2]);
                frames += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(frames, 1);
        pause.send(()).unwrap();
        assert_eq!(running.join().unwrap(), Err(Error::Stale));
        assert!(dropped.load(Ordering::SeqCst));
    }
    #[test]
    fn failed_initialization_is_reported_without_frames() {
        type Producer =
            fn(bool, u64, &mut dyn FnMut(Frame) -> Result<(), Error>) -> Result<(), Error>;
        let worker = Worker::new(|| Err::<Producer, _>(Error::Unauthorized)).unwrap();
        assert_eq!(
            worker.group(false, &mut |_| panic!("unexpected frame")),
            Err(Error::Unauthorized)
        );
    }
}
