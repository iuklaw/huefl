// Which audio devices music sync would use, by the names the desktop shows:
// the active port plus the device, e.g. "Speakers – Family 17h … Analog Stereo"
// or "Internal Microphone – …" (what GNOME's sound settings display).
//
// One short-lived libpulse connection per call (blocking, bounded). It also
// tells the kind of problem apart for the readiness list: no sound server at
// all vs. a server without an output device.

use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
    /// Label of the default output (whose monitor "System audio" records).
    pub system: Option<String>,
    /// Label of the default input.
    pub microphone: Option<String>,
    /// PulseAudio names — compared to notice the user switching devices.
    #[serde(skip)]
    pub system_id: Option<String>,
    /// The default output's monitor source, as the server names it — what
    /// "System audio" records. (`@DEFAULT_MONITOR@` can't be trusted: on
    /// pipewire-pulse 0.3.48 it resolved to the microphone.)
    #[serde(skip)]
    pub system_monitor: Option<String>,
    #[serde(skip)]
    pub microphone_id: Option<String>,
    /// Recording from a Bluetooth headset's microphone switches it to its
    /// low-quality call mode — worth a hint in the UI.
    pub microphone_bluetooth: bool,
    /// "PulseAudio (on PipeWire 0.3.48) 15.0.0" — for bug reports.
    #[serde(skip)]
    pub server: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioProblem {
    /// No PulseAudio / pipewire-pulse to talk to (pure ALSA, JACK, …).
    NoServer,
    /// A sound server, but no default output device.
    NoOutput,
}

/// "Speakers" + "Family 17h … Stereo" → "Speakers – Family 17h … Stereo".
pub fn device_label(port: Option<&str>, description: Option<&str>) -> Option<String> {
    match (port.filter(|p| !p.is_empty()), description.filter(|d| !d.is_empty())) {
        (Some(port), Some(description)) => Some(format!("{port} – {description}")),
        (None, Some(description)) => Some(description.to_string()),
        (Some(port), None) => Some(port.to_string()),
        (None, None) => None,
    }
}

/// The exact source to record for `input`, from what `default_devices` found.
/// System audio needs the output's monitor — never a guess that could land on
/// the microphone. `Ok(None)` means "the server's default input".
pub fn capture_device(microphone: bool, devices: &AudioDevices) -> Result<Option<String>, String> {
    if microphone {
        return Ok(devices.microphone_id.clone());
    }
    devices
        .system_monitor
        .clone()
        .or_else(|| devices.system_id.as_ref().map(|sink| format!("{sink}.monitor")))
        .map(Some)
        .ok_or_else(|| "No audio output to listen to.".to_string())
}

/// Whether capture must reopen: the default device changed under us (e.g.
/// speakers → headset). An unknown current device is not a reason.
pub fn should_reopen(opened_on: Option<&str>, current: Option<&str>) -> bool {
    current.is_some() && current != opened_on
}

#[cfg(feature = "sync-audio")]
pub fn default_devices() -> Result<AudioDevices, AudioProblem> {
    pulse::query()
}

#[cfg(not(feature = "sync-audio"))]
pub fn default_devices() -> Result<AudioDevices, AudioProblem> {
    Err(AudioProblem::NoServer)
}

#[cfg(feature = "sync-audio")]
mod pulse {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    use libpulse_binding::callbacks::ListResult;
    use libpulse_binding::context::{Context, FlagSet, State};
    use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};
    use libpulse_binding::operation::{Operation, State as OperationState};

    use super::{device_label, AudioDevices, AudioProblem};

    const TIMEOUT: Duration = Duration::from_secs(2);

    struct Session {
        mainloop: Mainloop,
        context: Context,
        deadline: Instant,
    }

    impl Session {
        fn connect() -> Result<Self, AudioProblem> {
            let mainloop = Mainloop::new().ok_or(AudioProblem::NoServer)?;
            let mut context = Context::new(&mainloop, "HueFL").ok_or(AudioProblem::NoServer)?;
            // No autospawn: asking must not start a sound server as a side effect.
            context
                .connect(None, FlagSet::NOAUTOSPAWN, None)
                .map_err(|_| AudioProblem::NoServer)?;
            let mut session = Self { mainloop, context, deadline: Instant::now() + TIMEOUT };
            loop {
                session.step()?;
                match session.context.get_state() {
                    State::Ready => return Ok(session),
                    State::Failed | State::Terminated => return Err(AudioProblem::NoServer),
                    _ => {}
                }
            }
        }

        fn step(&mut self) -> Result<(), AudioProblem> {
            if Instant::now() > self.deadline {
                return Err(AudioProblem::NoServer);
            }
            match self.mainloop.iterate(false) {
                IterateResult::Success(0) => std::thread::sleep(Duration::from_millis(2)),
                IterateResult::Success(_) => {}
                IterateResult::Quit(_) | IterateResult::Err(_) => return Err(AudioProblem::NoServer),
            }
            Ok(())
        }

        fn wait<T: ?Sized>(&mut self, operation: &Operation<T>) -> Result<(), AudioProblem> {
            while operation.get_state() == OperationState::Running {
                self.step()?;
            }
            Ok(())
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            self.context.disconnect();
        }
    }

    pub fn query() -> Result<AudioDevices, AudioProblem> {
        let mut session = Session::connect()?;
        let introspect = session.context.introspect();

        type Defaults = (Option<String>, Option<String>, Option<String>);
        let defaults: Rc<RefCell<Defaults>> = Rc::default();
        let op = introspect.get_server_info({
            let defaults = defaults.clone();
            move |info| {
                let server = info.server_name.as_ref().map(|name| match &info.server_version {
                    Some(version) => format!("{name} {version}"),
                    None => name.to_string(),
                });
                *defaults.borrow_mut() = (
                    info.default_sink_name.as_ref().map(|n| n.to_string()),
                    info.default_source_name.as_ref().map(|n| n.to_string()),
                    server,
                );
            }
        });
        session.wait(&op)?;
        let (sink, source, server) = defaults.borrow().clone();
        let Some(sink) = sink else {
            return Err(AudioProblem::NoOutput);
        };

        let mut devices = AudioDevices { system_id: Some(sink.clone()), microphone_id: source.clone(), server, ..Default::default() };

        let label: Rc<RefCell<Option<String>>> = Rc::default();
        let monitor: Rc<RefCell<Option<String>>> = Rc::default();
        let op = introspect.get_sink_info_by_name(&sink, {
            let (label, monitor) = (label.clone(), monitor.clone());
            move |result| {
                if let ListResult::Item(info) = result {
                    let port = info.active_port.as_ref().and_then(|p| p.description.as_deref());
                    *label.borrow_mut() = device_label(port, info.description.as_deref());
                    *monitor.borrow_mut() = info.monitor_source_name.as_ref().map(|n| n.to_string());
                }
            }
        });
        session.wait(&op)?;
        devices.system = label.borrow_mut().take();
        devices.system_monitor = monitor.borrow_mut().take();

        if let Some(source) = source {
            devices.microphone_bluetooth = source.contains("bluez");
            let op = introspect.get_source_info_by_name(&source, {
                let label = label.clone();
                move |result| {
                    if let ListResult::Item(info) = result {
                        let port = info.active_port.as_ref().and_then(|p| p.description.as_deref());
                        *label.borrow_mut() = device_label(port, info.description.as_deref());
                    }
                }
            });
            session.wait(&op)?;
            devices.microphone = label.borrow_mut().take();
        }

        Ok(devices)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_like_the_desktop() {
        assert_eq!(
            device_label(Some("Speakers"), Some("Family 17h HD Audio Controller Analog Stereo")).as_deref(),
            Some("Speakers – Family 17h HD Audio Controller Analog Stereo")
        );
        assert_eq!(device_label(None, Some("Razer Barracuda X")).as_deref(), Some("Razer Barracuda X"));
        assert_eq!(device_label(Some(""), Some("HDMI")).as_deref(), Some("HDMI"));
        assert_eq!(device_label(None, None), None);
    }

    #[test]
    fn reopens_only_on_a_real_switch() {
        assert!(should_reopen(Some("speakers"), Some("headset")));
        assert!(!should_reopen(Some("speakers"), Some("speakers")));
        assert!(!should_reopen(Some("speakers"), None), "a failed lookup is not a switch");
        assert!(should_reopen(None, Some("speakers")));
    }

    #[test]
    fn system_audio_records_the_monitor_never_the_microphone() {
        let devices = AudioDevices {
            system_id: Some("alsa_output.pci.analog-stereo".into()),
            system_monitor: Some("alsa_output.pci.analog-stereo.monitor".into()),
            microphone_id: Some("alsa_input.pci.analog-stereo".into()),
            ..Default::default()
        };
        assert_eq!(capture_device(false, &devices).unwrap().as_deref(), Some("alsa_output.pci.analog-stereo.monitor"));
        assert_eq!(capture_device(true, &devices).unwrap().as_deref(), Some("alsa_input.pci.analog-stereo"));

        // Monitor name unknown: derive it from the output, still not the mic.
        let derived = AudioDevices { system_monitor: None, ..devices.clone() };
        assert_eq!(capture_device(false, &derived).unwrap().as_deref(), Some("alsa_output.pci.analog-stereo.monitor"));

        // No output at all: refuse rather than fall back to the default input.
        assert!(capture_device(false, &AudioDevices::default()).is_err());
        assert_eq!(capture_device(true, &AudioDevices::default()).unwrap(), None);
    }

    /// Live: `cargo test --lib live_audio_devices -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_audio_devices() {
        println!("{:#?}", default_devices());
    }
}
