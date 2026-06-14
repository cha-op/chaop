use std::sync::{
    Once,
    atomic::{AtomicBool, AtomicI32, Ordering},
};

static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);
static INSTALL_ONCE: Once = Once::new();
static INSTALL_ERROR: AtomicI32 = AtomicI32::new(0);

pub fn install_signal_handlers() -> std::io::Result<()> {
    install_signal_handlers_impl()
}

pub fn shutdown_requested() -> bool {
    SHUTDOWN_REQUESTED.load(Ordering::SeqCst)
}

#[cfg(test)]
pub(crate) fn request_shutdown_for_test() {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn reset_shutdown_for_test() {
    SHUTDOWN_REQUESTED.store(false, Ordering::SeqCst);
}

#[cfg(unix)]
fn install_signal_handlers_impl() -> std::io::Result<()> {
    INSTALL_ONCE.call_once(|| {
        if let Err(error) = install_unix_signal_handlers() {
            INSTALL_ERROR.store(
                error.raw_os_error().unwrap_or(libc::EINVAL),
                Ordering::SeqCst,
            );
        }
    });

    match INSTALL_ERROR.load(Ordering::SeqCst) {
        0 => Ok(()),
        code => Err(std::io::Error::from_raw_os_error(code)),
    }
}

#[cfg(not(unix))]
fn install_signal_handlers_impl() -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn install_unix_signal_handlers() -> std::io::Result<()> {
    install_unix_signal_handler(libc::SIGINT)?;
    install_unix_signal_handler(libc::SIGTERM)
}

#[cfg(unix)]
fn install_unix_signal_handler(signal: libc::c_int) -> std::io::Result<()> {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_flags = 0;
    action.sa_sigaction = handle_unix_shutdown_signal as *const () as usize;
    if unsafe { libc::sigemptyset(&mut action.sa_mask) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
extern "C" fn handle_unix_shutdown_signal(_signal: libc::c_int) {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::{request_shutdown_for_test, reset_shutdown_for_test, shutdown_requested};

    #[test]
    fn shutdown_flag_tracks_requested_shutdown() {
        reset_shutdown_for_test();
        assert!(!shutdown_requested());

        request_shutdown_for_test();

        assert!(shutdown_requested());
        reset_shutdown_for_test();
    }
}
