// Screen sync input: X11 capture and turning frames into light colors.

pub mod capture;
#[cfg(feature = "sync-screen-wayland")]
pub mod portal;
pub mod zones;
