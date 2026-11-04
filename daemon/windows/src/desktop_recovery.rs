//! DXGI requires releasing an invalid duplication before opening its replacement.
//! The caller invokes this only on its owning COM capture thread.
pub fn reopen<T, E>(slot: &mut Option<T>, open: impl FnOnce() -> Result<T, E>) -> Result<(), E> {
    drop(slot.take());
    *slot = Some(open()?);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, rc::Rc};
    struct Resource(Rc<Cell<usize>>);
    impl Drop for Resource {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }
    #[test]
    fn old_resource_drops_before_open_and_failure_leaves_no_stale_resource() {
        for fail in [false, true] {
            let dropped = Rc::new(Cell::new(0));
            let mut slot = Some(Resource(dropped.clone()));
            let result = reopen(&mut slot, || {
                assert_eq!(dropped.get(), 1);
                if fail {
                    Err(())
                } else {
                    Ok(Resource(dropped.clone()))
                }
            });
            assert_eq!(result.is_err(), fail);
            assert_eq!(slot.is_none(), fail);
            drop(slot);
            assert_eq!(dropped.get(), if fail { 1 } else { 2 });
        }
    }
}
