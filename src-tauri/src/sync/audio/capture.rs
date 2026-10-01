// Captures audio for music sync on its own thread and keeps the latest
// analysis in shared `Features`.
//
// "System audio" records the default output's monitor - by the exact source
// name the server reports (see devices::capture_device) - and "Microphone"
// the default input. Works on PulseAudio and PipeWire
// (pipewire-pulse). Kept working through the things that happen mid-sync:
//   - the user switches output (speakers → headset): the monitor name is
//     resolved when a stream opens, so the thread checks the default device
//     every 2 s and reopens on the new one;
//   - the sound server restarts or goes away: features drop to silence (lights
//     dim instead of freezing), `lost` is raised, and the thread retries with
//     backoff until audio is back.
//
// RAII: dropping an `AudioSource` stops and joins the thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use super::analyzer::Features;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioInput {
    System,
    Microphone,
}

impl AudioInput {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("microphone") => Self::Microphone,
            _ => Self::System,
        }
    }
}

/// What happened to the input mid-sync - the caller logs it.
#[derive(Clone, Debug, PartialEq)]
pub enum AudioEvent {
    /// Recording from this source (its PulseAudio name).
    Opened(String),
    Lost(String),
    Restored,
    /// Reopened on a new default device (its label, when known).
    Switched(Option<String>),
}

pub type EventSink = Box<dyn Fn(AudioEvent) + Send>;

pub struct AudioSource {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for AudioSource {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(feature = "sync-audio")]
mod pulse {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use libpulse_binding::def::BufferAttr;
    use libpulse_binding::sample::{Format, Spec};
    use libpulse_binding::stream::Direction;
    use libpulse_simple_binding::Simple;

    use super::{AudioEvent, AudioInput, AudioSource, EventSink};
    use crate::sync::audio::analyzer::{Analyzer, Features, BLOCK, SAMPLE_RATE};
    use crate::sync::audio::devices::{self, should_reopen};

    const DEVICE_CHECK: Duration = Duration::from_secs(2);
    const RETRY_MIN: Duration = Duration::from_millis(500);
    const RETRY_MAX: Duration = Duration::from_secs(5);

    /// Opens a recording stream on the exact source for `input`; returns it
    /// with the source's name (for the log).
    fn open(input: AudioInput) -> Result<(Simple, String), String> {
        let spec = Spec { format: Format::F32le, rate: SAMPLE_RATE as u32, channels: 1 };
        // Small fragments: the server hands over each block as soon as it is
        // full, instead of batching ~2 s by default (latency).
        let bytes = (BLOCK * std::mem::size_of::<f32>()) as u32;
        let attr = BufferAttr { maxlength: u32::MAX, tlength: u32::MAX, prebuf: u32::MAX, minreq: u32::MAX, fragsize: bytes };
        let found = devices::default_devices().map_err(|problem| format!("Can't capture audio: {problem:?}"))?;
        let device = devices::capture_device(input == AudioInput::Microphone, &found)?;
        let simple = Simple::new(None, "HueFL", Direction::Record, device.as_deref(), "Light sync", &spec, None, Some(&attr))
            .map_err(|e| format!("Can't capture audio: {e}"))?;
        Ok((simple, device.unwrap_or_else(|| "default input".into())))
    }

    /// The default device's name right now (None if it can't be told).
    fn current_device(input: AudioInput) -> Option<String> {
        let found = devices::default_devices().ok()?;
        match input {
            AudioInput::System => found.system_id,
            AudioInput::Microphone => found.microphone_id,
        }
    }

    fn current_label(input: AudioInput) -> Option<String> {
        let found = devices::default_devices().ok()?;
        match input {
            AudioInput::System => found.system,
            AudioInput::Microphone => found.microphone,
        }
    }

    /// Sleeps in short steps so a stop request is honoured quickly.
    fn wait(stop: &AtomicBool, duration: Duration) {
        let until = Instant::now() + duration;
        while Instant::now() < until && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn start(
        input: AudioInput,
        features: Arc<Mutex<Features>>,
        lost: Arc<AtomicBool>,
        on_event: EventSink,
    ) -> Result<AudioSource, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("hue-sync-audio".into())
            .spawn({
                let stop = stop.clone();
                move || {
                    let mut ready = Some(ready_tx);
                    let mut retry = RETRY_MIN;
                    let mut bytes = vec![0u8; BLOCK * 4];
                    let mut block = vec![0f32; BLOCK];

                    while !stop.load(Ordering::SeqCst) {
                        // Simple is not Send: it lives and dies on this thread.
                        let opened_on = current_device(input);
                        let simple = match open(input) {
                            Ok((simple, device)) => {
                                on_event(AudioEvent::Opened(device));
                                simple
                            }
                            Err(e) => {
                                // The first attempt decides whether sync starts at all.
                                if let Some(ready) = ready.take() {
                                    let _ = ready.send(Err(e));
                                    return;
                                }
                                wait(&stop, retry);
                                retry = (retry * 2).min(RETRY_MAX);
                                continue;
                            }
                        };
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(Ok(()));
                        }
                        if lost.swap(false, Ordering::SeqCst) {
                            on_event(AudioEvent::Restored);
                        }
                        retry = RETRY_MIN;
                        let mut analyzer = Analyzer::default();
                        let mut checked = Instant::now();

                        while !stop.load(Ordering::SeqCst) {
                            if let Err(e) = simple.read(&mut bytes) {
                                // Server gone or restarting: go dark, then retry.
                                *features.lock().unwrap() = Features::default();
                                lost.store(true, Ordering::SeqCst);
                                on_event(AudioEvent::Lost(e.to_string().unwrap_or_else(|| format!("{e:?}"))));
                                break;
                            }
                            for (sample, chunk) in block.iter_mut().zip(bytes.as_chunks::<4>().0) {
                                *sample = f32::from_le_bytes(*chunk);
                            }
                            let latest = analyzer.process(&block);
                            *features.lock().unwrap() = latest;

                            if checked.elapsed() >= DEVICE_CHECK {
                                checked = Instant::now();
                                if should_reopen(opened_on.as_deref(), current_device(input).as_deref()) {
                                    on_event(AudioEvent::Switched(current_label(input)));
                                    break; // reopen on the new default
                                }
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(AudioSource { stop, thread: Some(thread) }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err("audio thread ended unexpectedly".into()),
        }
    }
}

impl AudioSource {
    /// Starts capturing; fails if audio can't be opened at all. Later losses
    /// are handled inside (see the module comment) and reported via `on_event`.
    pub fn start(
        input: AudioInput,
        features: Arc<Mutex<Features>>,
        lost: Arc<AtomicBool>,
        on_event: EventSink,
    ) -> Result<Self, String> {
        #[cfg(feature = "sync-audio")]
        return pulse::start(input, features, lost, on_event);
        #[cfg(not(feature = "sync-audio"))]
        {
            let _ = (input, features, lost, on_event);
            Err("This build has no audio support (feature sync-audio).".into())
        }
    }
}

/// Live check: capture 2 s of system audio and print what the analyzer sees.
/// Run: `cargo test --lib live_capture -- --ignored --nocapture` (play music for non-zero values)
#[cfg(all(test, feature = "sync-audio"))]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_capture() {
        let features = Arc::new(Mutex::new(Features::default()));
        let lost = Arc::new(AtomicBool::new(false));
        let source = AudioSource::start(
            AudioInput::System,
            features.clone(),
            lost,
            Box::new(|event| println!("event: {event:?}")),
        )
        .expect("capture");
        let started = std::time::Instant::now();
        for _ in 0..4 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            println!("{:>5} ms: {:?}", started.elapsed().as_millis(), *features.lock().unwrap());
        }
        drop(source);
        println!("stopped cleanly after {} ms", started.elapsed().as_millis());
    }
}
