//! Coalesce concurrent calls into one run whose result every caller shares (#1371).
//!
//! Moving a `#[tauri::command]` off the main thread removes an *accidental*
//! mutex: Tauri dispatches sync commands inline on the UI thread, so two of them
//! could never overlap. `cowork_detect_vethernet_subnet` sits behind a
//! user-repeatable "Check again" button, so without a replacement guard N rapid
//! clicks become N concurrent `powershell.exe` processes — and against a wedged
//! WMI service, N processes that never exit.
//!
//! ## Why a guard and not a queue
//!
//! A plain `Mutex` would bound concurrency, but it makes the user's MOST RECENT
//! click the SLOWEST to answer. `useCoworkPreflight.svelte.ts` takes its ticket
//! synchronously and clears `probing` in `finally { if (mine === token) ... }`,
//! so the spinner persists until the *newest* probe resolves — which under FIFO
//! is last in the queue. Ten clicks against a wedged service would hold the UI at
//! "Checking…" for ten consecutive deadlines, each click making it strictly
//! worse. A UI whose only affordance is "try again" must not punish the user for
//! using it. #1371 asks for "an in-flight guard so at most one probe runs at a
//! time" — a guard, not a queue. Coalescing gives N callers ONE run, all
//! answering at the same instant.
//!
//! ## Why this is a guard and NOT a cache
//!
//! The registration is cleared *before* the result is published, so a caller
//! arriving after completion starts a fresh run rather than joining a finished
//! one. That is load-bearing, not tidiness: `cowork-invoke.ts` states that the
//! pre-flight "does not replace the check inside the enable path … the VM can
//! stop between the two". A cached answer would survive the VM starting or
//! stopping and tell the user something false about their machine.
//!
//! Not cfg-gated, so it is type-checked and unit-tested on every CI leg.

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Backstop on how long a follower waits for the leader's answer.
///
/// Should be unreachable: the leader's own work is deadline-bounded by its
/// caller, and `LeaderGuard`'s `Drop` publishes even on panic. If it ever does
/// fire, `run` returns `None` and the caller surfaces an unclassifiable error —
/// which is the correct destination, because reaching here means a bug.
const FOLLOWER_WAIT_CAP: Duration = Duration::from_secs(120);

/// What a finished flight left behind for its followers.
enum Publication<T> {
    Value(T),
    /// The leader unwound without producing a value (it panicked).
    Abandoned,
}

struct Slot<T> {
    done: Mutex<Option<Publication<T>>>,
    cv: Condvar,
}

impl<T> Slot<T> {
    fn new() -> Self {
        Slot {
            done: Mutex::new(None),
            cv: Condvar::new(),
        }
    }
}

/// One in-flight call; contending callers subscribe to its result.
pub struct SingleFlight<T> {
    inner: Mutex<Option<Arc<Slot<T>>>>,
}

impl<T> SingleFlight<T> {
    /// `const` so this can live in a `static` without a lazy initializer.
    pub const fn new() -> Self {
        SingleFlight {
            inner: Mutex::new(None),
        }
    }
}

impl<T: Clone> SingleFlight<T> {
    /// Run `f`, or — if a run is already in flight — wait for that run's result.
    ///
    /// Returns `None` when the flight was abandoned: the leader panicked (the
    /// panic still propagates on the leader's own thread), or a follower hit
    /// [`FOLLOWER_WAIT_CAP`]. Callers map `None` to their own error type.
    pub fn run(&self, f: impl FnOnce() -> T) -> Option<T> {
        let (slot, is_leader) = self.enlist();
        if is_leader {
            // The guard owns clearing the registration and waking followers, so
            // a panic inside `f` unwinds through it and cannot wedge them.
            let mut guard = LeaderGuard {
                flight: self,
                slot,
                value: None,
            };
            let value = f();
            guard.value = Some(value.clone());
            drop(guard);
            return Some(value);
        }
        follow(&slot)
    }

    /// Decide leadership under a short lock that is NEVER held across `f`.
    fn enlist(&self) -> (Arc<Slot<T>>, bool) {
        let mut current = lock(&self.inner);
        match current.as_ref() {
            Some(existing) => (Arc::clone(existing), false),
            None => {
                let slot = Arc::new(Slot::new());
                *current = Some(Arc::clone(&slot));
                (slot, true)
            }
        }
    }
}

fn follow<T: Clone>(slot: &Slot<T>) -> Option<T> {
    let mut done = lock(&slot.done);
    let deadline = Instant::now() + FOLLOWER_WAIT_CAP;
    loop {
        match done.as_ref() {
            Some(Publication::Value(value)) => return Some(value.clone()),
            Some(Publication::Abandoned) => return None,
            None => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let (guard, _) = slot
            .cv
            .wait_timeout(done, remaining)
            .unwrap_or_else(|e| e.into_inner());
        done = guard;
    }
}

struct LeaderGuard<'a, T: Clone> {
    flight: &'a SingleFlight<T>,
    slot: Arc<Slot<T>>,
    value: Option<T>,
}

impl<T: Clone> Drop for LeaderGuard<'_, T> {
    fn drop(&mut self) {
        // 1. Clear the registration FIRST. A caller arriving after this point
        //    must start a fresh run, not join a finished one — see the module
        //    doc on guard-not-cache.
        {
            let mut current = lock(&self.flight.inner);
            // `Arc::ptr_eq` is defence in depth. Under the current lock
            // discipline a newer slot cannot be installed before this clear
            // (installation needs the same lock), so it is not reachable today —
            // it is here so that a future refactor which moves the clear outside
            // the lock cannot silently deregister somebody else's live flight.
            if current.as_ref().is_some_and(|s| Arc::ptr_eq(s, &self.slot)) {
                *current = None;
            }
        }
        // 2. Publish and wake every follower. `Abandoned` when `value` is None,
        //    which is the unwinding-from-a-panic path.
        let mut done = lock(&self.slot.done);
        *done = Some(match self.value.take() {
            Some(value) => Publication::Value(value),
            None => Publication::Abandoned,
        });
        drop(done);
        self.slot.cv.notify_all();
    }
}

/// Poison-tolerant lock. A panic inside one run must not permanently disable the
/// button this guard protects.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Barrier};
    use std::thread;

    /// THE test that separates this design from the rejected blocking mutex:
    /// with a mutex the counter is N, with coalescing it is exactly 1.
    #[test]
    fn concurrent_callers_share_one_run() {
        let flight: Arc<SingleFlight<usize>> = Arc::new(SingleFlight::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(10));

        let handles: Vec<_> = (0..10)
            .map(|_| {
                let flight = Arc::clone(&flight);
                let runs = Arc::clone(&runs);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    flight.run(|| {
                        runs.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(150));
                        42usize
                    })
                })
            })
            .collect();

        let results: Vec<_> = handles.into_iter().map(|h| h.join().expect("join")).collect();
        assert_eq!(
            runs.load(Ordering::SeqCst),
            1,
            "the closure ran more than once — callers were serialized, not coalesced"
        );
        assert!(
            results.iter().all(|r| *r == Some(42usize)),
            "not every caller received the leader's answer: {results:?}"
        );
    }

    /// Red if the registration is never cleared at all — the guard would silently
    /// become a cache, and a stale answer would survive the VM starting or
    /// stopping.
    ///
    /// It does NOT pin the ORDER of the two blocks in `LeaderGuard::drop`.
    /// Publish-then-clear leaves this test (and both its siblings) green while
    /// opening a real window: the leader publishes at T and clears at T+e, and a
    /// caller enlisting inside (T, T+e) finds the finished slot still registered,
    /// becomes a follower, and is handed the completed flight's answer. That
    /// order is pinned by a source-text assertion in
    /// `tests/build/cowork-subnet-probe-contract.test.ts`, because nothing about
    /// it is observable from inside this module.
    #[test]
    fn a_later_caller_starts_a_fresh_run() {
        let flight: SingleFlight<usize> = SingleFlight::new();
        let runs = AtomicUsize::new(0);

        let first = flight.run(|| runs.fetch_add(1, Ordering::SeqCst));
        let second = flight.run(|| runs.fetch_add(1, Ordering::SeqCst));

        assert_eq!(first, Some(0));
        assert_eq!(second, Some(1));
        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "a caller arriving after completion joined a finished flight — this is a cache, not a guard"
        );
    }

    /// Red if `LeaderGuard::Drop` stops publishing and notifying: followers would
    /// block until `FOLLOWER_WAIT_CAP`, so the bounded `recv_timeout` below fails
    /// in 5s rather than the test hanging for two minutes.
    ///
    /// The leader's panic message on stderr is expected output, not a failure.
    #[test]
    fn a_panicking_leader_does_not_wedge_followers() {
        let flight: Arc<SingleFlight<usize>> = Arc::new(SingleFlight::new());
        let barrier = Arc::new(Barrier::new(4));
        let (tx, rx) = mpsc::channel();

        let leader = {
            let flight = Arc::clone(&flight);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                flight.run(|| {
                    barrier.wait();
                    thread::sleep(Duration::from_millis(100));
                    panic!("deliberate leader panic");
                })
            })
        };

        for _ in 0..3 {
            let flight = Arc::clone(&flight);
            let barrier = Arc::clone(&barrier);
            let tx = tx.clone();
            thread::spawn(move || {
                barrier.wait();
                // Give the leader time to install itself before we enlist.
                thread::sleep(Duration::from_millis(20));
                let _ = tx.send(flight.run(|| 7usize));
            });
        }
        drop(tx);

        for i in 0..3 {
            let got = rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_else(|e| panic!("follower {i} never returned: {e}"));
            assert_eq!(got, None, "an abandoned flight must not hand back a value");
        }
        assert!(leader.join().is_err(), "the leader's panic must still propagate");

        // And the flight is usable again afterwards.
        let runs = AtomicUsize::new(0);
        assert_eq!(flight.run(|| runs.fetch_add(1, Ordering::SeqCst)), Some(0));
    }
}
