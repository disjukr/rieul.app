//! Explicit cluster management. No startup key generation or automatic admission.
mod primary;
#[cfg(test)]
mod proof;
#[cfg(test)]
mod slot;
pub use primary::runtime;
