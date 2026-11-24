//! Scrubs a native-crash minidump before the crash reporter sends it (#2161).
//!
//! Only reached when the operator opted in to crash reporting with
//! `TANDEM_SENTRY_DSN` (see `sentry_reporting.rs`). The minidump integration
//! attaches the dump after `before_send` has run, so the event hook never sees
//! its bytes. This module runs in the crash-reporter process instead, through
//! the integration's `before_capture` hook: it reads the dump the reporter just
//! wrote, scrubs it, and replaces the attachment. If the dump cannot be parsed
//! the attachment is dropped rather than sent as written — fail closed.
//!
//! ## What it removes
//!
//! - **The command-line, environment and open-file streams.** `minidump-writer`
//!   on Linux writes `/proc/<pid>/cmdline` (`LinuxCmdLine`),
//!   `/proc/<pid>/environ` (`LinuxEnviron`) and the resolved path of every open
//!   file descriptor (`HandleDataStream`, whose path strings live outside the
//!   stream and are reached through each descriptor's RVAs). Each stream's
//!   bytes, and the handle path strings, are zeroed, and its directory entry is
//!   retyped to `UnusedStream` so a reader skips it.
//! - **Copies of the environment and arguments in captured memory.** Removing
//!   the streams alone is not enough: on Linux (and, per the source, macOS)
//!   each thread's stack is captured from its stack pointer to the top of the
//!   stack mapping, and the top of the main thread's stack is where the kernel
//!   placed the process's argument and environment strings at exec. So every
//!   `KEY=value` entry and every argument after `argv[0]` is zeroed wherever
//!   it occurs in the dump. The needles come from the dump's own streams (the
//!   crashed process's authoritative values) and from this reporter process's
//!   own environment and arguments, which it inherited from the app at spawn —
//!   the only source on a platform that writes no environment stream.
//!
//! ## What it leaves
//!
//! - Needles shorter than [`MIN_NEEDLE_LEN`] bytes are not searched for, so a
//!   random short byte run in a stack cannot be mistaken for one and a return
//!   address corrupted. No credential fits in that length with its `KEY=`.
//! - `argv[0]` (the executable's path) is not searched for: it is also the
//!   main module's path, which the module list and `LinuxMaps` carry anyway,
//!   and zeroing it there would cost symbolication.
//! - A bare environment value copied somewhere without its `KEY=` prefix, a
//!   value on the heap (not captured by these dump types), and UTF-16 copies
//!   (Windows keeps its environment block in UTF-16 on the heap) are not
//!   searched for.
//! - Raw stack memory otherwise, the module list and `LinuxMaps` (both carry
//!   full paths, so a per-user install names the user), `/proc` status,
//!   cpuinfo, OS release, auxv, limits and thread names are kept: they are
//!   what makes the dump useful. `docs/security.md` ("Telemetry") is the
//!   authoritative inventory.
//!
//! Written from `minidump-writer` 0.12.0's source, not from measured dumps.
//! Confirming it needs a real native crash of a desktop build on each
//! platform with a DSN set.

use std::ffi::OsString;
use std::path::Path;

/// `MINIDUMP_SIGNATURE`, "MDMP" little-endian.
const MDMP_SIGNATURE: u32 = 0x504d_444d;
/// `MINIDUMP_HEADER` is 32 bytes; the fields read here are its first 16.
const HEADER_LEN: usize = 32;
/// `MINIDUMP_DIRECTORY`: `stream_type: u32`, `data_size: u32`, `rva: u32`.
const DIRECTORY_ENTRY_LEN: usize = 12;

const UNUSED_STREAM: u32 = 0;
const HANDLE_DATA_STREAM: u32 = 12;
const LINUX_CMD_LINE: u32 = 0x4767_0006;
const LINUX_ENVIRON: u32 = 0x4767_0007;

/// `MINIDUMP_HANDLE_DATA_STREAM` header: `size_of_header`,
/// `size_of_descriptor`, `number_of_descriptors`, `reserved` (all `u32`).
const HANDLE_STREAM_HEADER_LEN: usize = 16;
/// `MINIDUMP_HANDLE_DESCRIPTOR`: `handle: u64`, then `type_name_rva: u32` at 8
/// and `object_name_rva: u32` at 12. A descriptor shorter than 16 bytes cannot
/// hold both RVAs.
const HANDLE_TYPE_NAME_RVA_AT: usize = 8;
const HANDLE_OBJECT_NAME_RVA_AT: usize = 12;
const MIN_HANDLE_DESCRIPTOR_LEN: usize = 16;

/// The shortest needle searched for. See the module doc.
pub(crate) const MIN_NEEDLE_LEN: usize = 8;

/// Why a dump could not be scrubbed. Each makes the caller drop the dump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScrubError {
    TooShort,
    BadSignature,
    DirectoryOutOfBounds,
    StreamOutOfBounds,
    HandleDataMalformed,
}

impl ScrubError {
    /// A fixed string for the event's tag; never carries dump content.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ScrubError::TooShort => "too-short",
            ScrubError::BadSignature => "bad-signature",
            ScrubError::DirectoryOutOfBounds => "directory-out-of-bounds",
            ScrubError::StreamOutOfBounds => "stream-out-of-bounds",
            ScrubError::HandleDataMalformed => "handle-data-malformed",
        }
    }
}

fn read_u32(buf: &[u8], at: usize) -> Option<u32> {
    let bytes = buf.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

/// The byte range `[rva, rva + size)`, or `None` if it leaves the buffer.
fn range(buf_len: usize, rva: u32, size: u32) -> Option<std::ops::Range<usize>> {
    let start = rva as usize;
    let end = start.checked_add(size as usize)?;
    (end <= buf_len).then_some(start..end)
}

struct Stream {
    /// Offset of this stream's directory entry.
    entry_at: usize,
    stream_type: u32,
    data: std::ops::Range<usize>,
}

/// Parse the header and the directory entries of the streams this module
/// touches, bounds-checking every one before anything is written.
fn sensitive_streams(dump: &[u8]) -> Result<Vec<Stream>, ScrubError> {
    if dump.len() < HEADER_LEN {
        return Err(ScrubError::TooShort);
    }
    if read_u32(dump, 0) != Some(MDMP_SIGNATURE) {
        return Err(ScrubError::BadSignature);
    }
    let count = read_u32(dump, 8).ok_or(ScrubError::TooShort)? as usize;
    let dir_at = read_u32(dump, 12).ok_or(ScrubError::TooShort)? as usize;
    let dir_end = count
        .checked_mul(DIRECTORY_ENTRY_LEN)
        .and_then(|len| dir_at.checked_add(len))
        .ok_or(ScrubError::DirectoryOutOfBounds)?;
    if dir_end > dump.len() {
        return Err(ScrubError::DirectoryOutOfBounds);
    }

    let mut streams = Vec::new();
    for i in 0..count {
        let entry_at = dir_at + i * DIRECTORY_ENTRY_LEN;
        let stream_type = read_u32(dump, entry_at).ok_or(ScrubError::DirectoryOutOfBounds)?;
        if !matches!(
            stream_type,
            HANDLE_DATA_STREAM | LINUX_CMD_LINE | LINUX_ENVIRON
        ) {
            continue;
        }
        let size = read_u32(dump, entry_at + 4).ok_or(ScrubError::DirectoryOutOfBounds)?;
        let rva = read_u32(dump, entry_at + 8).ok_or(ScrubError::DirectoryOutOfBounds)?;
        let data = range(dump.len(), rva, size).ok_or(ScrubError::StreamOutOfBounds)?;
        streams.push(Stream {
            entry_at,
            stream_type,
            data,
        });
    }
    Ok(streams)
}

/// Every `MINIDUMP_STRING` a handle-data stream points at (handle type names
/// and object names, i.e. open file paths on Linux), as byte ranges covering
/// the length prefix, the UTF-16 text and its two-byte terminator.
fn handle_string_ranges(
    dump: &[u8],
    data: &std::ops::Range<usize>,
) -> Result<Vec<std::ops::Range<usize>>, ScrubError> {
    let stream = &dump[data.clone()];
    if stream.is_empty() {
        return Ok(Vec::new());
    }
    let malformed = ScrubError::HandleDataMalformed;
    if stream.len() < HANDLE_STREAM_HEADER_LEN {
        return Err(malformed);
    }
    let header_len = read_u32(stream, 0).ok_or(malformed)? as usize;
    let descriptor_len = read_u32(stream, 4).ok_or(malformed)? as usize;
    let descriptors = read_u32(stream, 8).ok_or(malformed)? as usize;
    if descriptors == 0 {
        return Ok(Vec::new());
    }
    if descriptor_len < MIN_HANDLE_DESCRIPTOR_LEN {
        return Err(malformed);
    }

    let mut ranges = Vec::new();
    for i in 0..descriptors {
        let at = i
            .checked_mul(descriptor_len)
            .and_then(|off| off.checked_add(header_len))
            .ok_or(malformed)?;
        for field in [HANDLE_TYPE_NAME_RVA_AT, HANDLE_OBJECT_NAME_RVA_AT] {
            let rva = read_u32(stream, at.checked_add(field).ok_or(malformed)?).ok_or(malformed)?;
            if rva == 0 {
                continue;
            }
            let start = rva as usize;
            let text_len = read_u32(dump, start).ok_or(malformed)? as usize;
            let text_end = start
                .checked_add(4)
                .and_then(|at| at.checked_add(text_len))
                .ok_or(malformed)?;
            if text_end > dump.len() {
                return Err(malformed);
            }
            // The two-byte terminator is not counted in the length, so clamp
            // it at the end of the buffer rather than fail on it.
            ranges.push(start..text_end.saturating_add(2).min(dump.len()));
        }
    }
    Ok(ranges)
}

/// Split a NUL-separated `/proc` block into its non-empty entries.
fn nul_entries(block: &[u8]) -> impl Iterator<Item = &[u8]> {
    block.split(|b| *b == 0).filter(|entry| !entry.is_empty())
}

/// Scrub `dump` in place. `extra_needles` are byte strings to zero wherever
/// they occur, in addition to the entries the dump's own command-line and
/// environment streams hold. Every offset is bounds-checked before the first
/// byte is written, so an error leaves `dump` untouched; the caller must then
/// not send it.
pub(crate) fn scrub_minidump(dump: &mut [u8], extra_needles: &[Vec<u8>]) -> Result<(), ScrubError> {
    let streams = sensitive_streams(dump)?;

    let mut needles: Vec<Vec<u8>> = extra_needles.to_vec();
    let mut handle_strings = Vec::new();
    for stream in &streams {
        let data = &dump[stream.data.clone()];
        match stream.stream_type {
            // argv[0] is the executable path: see the module doc.
            LINUX_CMD_LINE => needles.extend(nul_entries(data).skip(1).map(<[u8]>::to_vec)),
            LINUX_ENVIRON => needles.extend(nul_entries(data).map(<[u8]>::to_vec)),
            HANDLE_DATA_STREAM => handle_strings.extend(handle_string_ranges(dump, &stream.data)?),
            _ => {}
        }
    }

    for range in handle_strings {
        dump[range].fill(0);
    }
    for stream in &streams {
        dump[stream.data.clone()].fill(0);
        dump[stream.entry_at..stream.entry_at + 4].copy_from_slice(&UNUSED_STREAM.to_le_bytes());
    }

    needles.retain(|needle| needle.len() >= MIN_NEEDLE_LEN);
    needles.sort_unstable();
    needles.dedup();
    for needle in &needles {
        zero_occurrences(dump, needle);
    }
    Ok(())
}

/// Zero every non-overlapping occurrence of `needle` in `haystack`.
fn zero_occurrences(haystack: &mut [u8], needle: &[u8]) {
    let finder = memchr::memmem::Finder::new(needle);
    let mut from = 0;
    while let Some(found) = finder.find(&haystack[from..]) {
        let start = from + found;
        haystack[start..start + needle.len()].fill(0);
        from = start + needle.len();
    }
}

/// `KEY=value` for every variable in `vars`, and every argument after the
/// first in `args`, as bytes.
fn needles_from(
    vars: impl Iterator<Item = (OsString, OsString)>,
    args: impl Iterator<Item = OsString>,
) -> Vec<Vec<u8>> {
    let mut needles = Vec::new();
    for (key, value) in vars {
        let mut entry = key.as_encoded_bytes().to_vec();
        entry.push(b'=');
        entry.extend_from_slice(value.as_encoded_bytes());
        needles.push(entry);
    }
    needles.extend(args.skip(1).map(|arg| arg.as_encoded_bytes().to_vec()));
    needles
}

/// The integration's `before_capture` hook, run in the crash-reporter process
/// with the scope that already holds the unscrubbed minidump attachment.
///
/// Replaces that attachment with a scrubbed copy read from `path` (the file
/// the reporter wrote and deletes after this returns), or drops it. The tag
/// `minidump.scrub` records which, so an operator can tell a dropped dump
/// from a crash that produced none.
pub(crate) fn scrub_minidump_attachment(scope: &mut sentry::Scope, path: &Path) {
    scope.clear_attachments();
    let needles = needles_from(std::env::vars_os(), std::env::args_os());
    let scrubbed = std::fs::read(path)
        .map_err(|_| "unreadable")
        .and_then(|mut dump| match scrub_minidump(&mut dump, &needles) {
            Ok(()) => Ok(dump),
            Err(err) => Err(err.as_str()),
        });
    match scrubbed {
        Ok(dump) => {
            let filename = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "minidump.dmp".to_string());
            scope.add_attachment(sentry::protocol::Attachment {
                buffer: dump,
                filename,
                ty: Some(sentry::protocol::AttachmentType::Minidump),
                ..Default::default()
            });
            scope.set_tag("minidump.scrub", "scrubbed");
        }
        Err(reason) => scope.set_tag("minidump.scrub", format!("dropped: {reason}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic dump: header, directory, then each stream's bytes in order,
    /// then `tail` (stands in for captured memory). Returns the dump and each
    /// stream's data offset.
    fn build(streams: &[(u32, Vec<u8>)], tail: &[u8]) -> (Vec<u8>, Vec<usize>) {
        let dir_at = HEADER_LEN;
        let mut data_at = dir_at + streams.len() * DIRECTORY_ENTRY_LEN;
        let mut dump = vec![0u8; data_at];
        dump[0..4].copy_from_slice(&MDMP_SIGNATURE.to_le_bytes());
        dump[8..12].copy_from_slice(&(streams.len() as u32).to_le_bytes());
        dump[12..16].copy_from_slice(&(dir_at as u32).to_le_bytes());
        let mut offsets = Vec::new();
        for (i, (ty, data)) in streams.iter().enumerate() {
            let entry = dir_at + i * DIRECTORY_ENTRY_LEN;
            dump[entry..entry + 4].copy_from_slice(&ty.to_le_bytes());
            dump[entry + 4..entry + 8].copy_from_slice(&(data.len() as u32).to_le_bytes());
            dump[entry + 8..entry + 12].copy_from_slice(&(data_at as u32).to_le_bytes());
            offsets.push(data_at);
            data_at += data.len();
        }
        for (_, data) in streams {
            dump.extend_from_slice(data);
        }
        dump.extend_from_slice(tail);
        (dump, offsets)
    }

    fn stream_type_at(dump: &[u8], index: usize) -> u32 {
        read_u32(dump, HEADER_LEN + index * DIRECTORY_ENTRY_LEN).unwrap()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        memchr::memmem::find(haystack, needle).is_some()
    }

    const ENVIRON: &[u8] = b"HOME=/home/bob\0SECRET_API_KEY=sk-live-abcdef\0A=1\0";
    const CMDLINE: &[u8] = b"/opt/tandem/tandem\0/home/bob/private/plan.md\0--tandem-autostart\0";

    #[test]
    fn blanks_cmdline_and_environ_streams_and_their_stack_copies() {
        // The top of the main thread's stack: argv then envp strings.
        let mut stack = b"\x01\x02\x03\x04frame".to_vec();
        stack.extend_from_slice(CMDLINE);
        stack.extend_from_slice(ENVIRON);
        let other_stream = b"unrelated stream data".to_vec();
        let (mut dump, _) = build(
            &[
                (LINUX_CMD_LINE, CMDLINE.to_vec()),
                (7, other_stream.clone()),
                (LINUX_ENVIRON, ENVIRON.to_vec()),
            ],
            &stack,
        );

        scrub_minidump(&mut dump, &[]).unwrap();

        assert_eq!(stream_type_at(&dump, 0), UNUSED_STREAM);
        assert_eq!(stream_type_at(&dump, 1), 7, "other streams keep their type");
        assert_eq!(stream_type_at(&dump, 2), UNUSED_STREAM);
        for secret in [
            &b"sk-live-abcdef"[..],
            b"/home/bob/private/plan.md",
            b"--tandem-autostart",
            b"HOME=/home/bob",
        ] {
            assert!(
                !contains(&dump, secret),
                "{} survived",
                String::from_utf8_lossy(secret)
            );
        }
        assert!(
            contains(&dump, &other_stream),
            "an untouched stream is kept"
        );
        assert!(
            contains(&dump, b"\x01\x02\x03\x04frame"),
            "other stack bytes are kept"
        );
        // argv[0] is searched for nowhere, so its stack copy survives; its
        // stream copy was zeroed with the stream.
        assert!(contains(&dump, b"/opt/tandem/tandem"));
    }

    #[test]
    fn needles_shorter_than_the_minimum_are_not_searched() {
        let (mut dump, _) = build(&[(LINUX_ENVIRON, b"A=1\0".to_vec())], b"..A=1..");
        scrub_minidump(&mut dump, &[]).unwrap();
        assert!(contains(&dump, b"..A=1.."));
    }

    #[test]
    fn extra_needles_are_zeroed_without_any_environment_stream() {
        // The macOS/Windows shape: no environment stream, a stack copy anyway.
        let (mut dump, _) = build(&[(3, b"threads".to_vec())], b"xxTOKEN=abcdefghijxx");
        scrub_minidump(&mut dump, &[b"TOKEN=abcdefghij".to_vec()]).unwrap();
        assert!(!contains(&dump, b"TOKEN=abcdefghij"));
        assert!(contains(&dump, b"threads"));
        assert_eq!(stream_type_at(&dump, 0), 3);
    }

    #[test]
    fn every_occurrence_is_zeroed() {
        let (mut dump, _) = build(&[], b"KEY=value123 KEY=value123 KEY=value123");
        scrub_minidump(&mut dump, &[b"KEY=value123".to_vec()]).unwrap();
        assert!(!contains(&dump, b"KEY=value123"));
    }

    fn utf16_minidump_string(text: &str) -> Vec<u8> {
        let units: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut out = (units.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&units);
        out.extend_from_slice(&[0, 0]);
        out
    }

    #[test]
    fn handle_data_path_strings_are_zeroed() {
        // Lay out: [path string][handle stream], as minidump-writer does.
        let path = utf16_minidump_string("/home/bob/private/plan.md");
        let path_utf16: Vec<u8> = path[4..path.len() - 2].to_vec();

        // Build once to learn where the stream data lands, then patch the RVA.
        let handle_stream_len = HANDLE_STREAM_HEADER_LEN + 32;
        let (mut dump, offsets) = build(
            &[
                (3, path.clone()),
                (HANDLE_DATA_STREAM, vec![0u8; handle_stream_len]),
            ],
            &[],
        );
        let path_rva = offsets[0] as u32;
        let hs = offsets[1];
        dump[hs..hs + 4].copy_from_slice(&(HANDLE_STREAM_HEADER_LEN as u32).to_le_bytes());
        dump[hs + 4..hs + 8].copy_from_slice(&32u32.to_le_bytes());
        dump[hs + 8..hs + 12].copy_from_slice(&1u32.to_le_bytes());
        let d = hs + HANDLE_STREAM_HEADER_LEN;
        dump[d + 12..d + 16].copy_from_slice(&path_rva.to_le_bytes());

        scrub_minidump(&mut dump, &[]).unwrap();

        assert!(!contains(&dump, &path_utf16), "the open-file path survived");
        assert_eq!(stream_type_at(&dump, 1), UNUSED_STREAM);
        assert!(dump[hs..hs + handle_stream_len].iter().all(|b| *b == 0));
    }

    #[test]
    fn handle_data_with_an_out_of_bounds_rva_fails_closed() {
        let handle_stream_len = HANDLE_STREAM_HEADER_LEN + 32;
        let (mut dump, offsets) = build(&[(HANDLE_DATA_STREAM, vec![0u8; handle_stream_len])], &[]);
        let hs = offsets[0];
        dump[hs..hs + 4].copy_from_slice(&(HANDLE_STREAM_HEADER_LEN as u32).to_le_bytes());
        dump[hs + 4..hs + 8].copy_from_slice(&32u32.to_le_bytes());
        dump[hs + 8..hs + 12].copy_from_slice(&1u32.to_le_bytes());
        let d = hs + HANDLE_STREAM_HEADER_LEN;
        dump[d + 12..d + 16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            scrub_minidump(&mut dump, &[]),
            Err(ScrubError::HandleDataMalformed)
        );
    }

    #[test]
    fn handle_data_with_too_many_descriptors_fails_closed() {
        let (mut dump, offsets) = build(
            &[(HANDLE_DATA_STREAM, vec![0u8; HANDLE_STREAM_HEADER_LEN])],
            &[],
        );
        let hs = offsets[0];
        dump[hs..hs + 4].copy_from_slice(&(HANDLE_STREAM_HEADER_LEN as u32).to_le_bytes());
        dump[hs + 4..hs + 8].copy_from_slice(&32u32.to_le_bytes());
        dump[hs + 8..hs + 12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            scrub_minidump(&mut dump, &[]),
            Err(ScrubError::HandleDataMalformed)
        );
    }

    #[test]
    fn malformed_dumps_are_refused() {
        assert_eq!(
            scrub_minidump(&mut [0u8; 8], &[]),
            Err(ScrubError::TooShort)
        );

        let (mut dump, _) = build(&[], &[]);
        dump[0] = b'X';
        assert_eq!(
            scrub_minidump(&mut dump, &[]),
            Err(ScrubError::BadSignature)
        );

        let (mut dump, _) = build(&[], &[]);
        dump[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            scrub_minidump(&mut dump, &[]),
            Err(ScrubError::DirectoryOutOfBounds)
        );

        let (mut dump, _) = build(&[(LINUX_ENVIRON, ENVIRON.to_vec())], &[]);
        let size_at = HEADER_LEN + 4;
        dump[size_at..size_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            scrub_minidump(&mut dump, &[]),
            Err(ScrubError::StreamOutOfBounds)
        );
    }

    #[test]
    fn needles_from_builds_entries_and_skips_argv0() {
        let needles = needles_from(
            [(OsString::from("KEY"), OsString::from("value"))].into_iter(),
            ["/opt/tandem", "/home/bob/plan.md"]
                .into_iter()
                .map(OsString::from),
        );
        assert_eq!(
            needles,
            vec![b"KEY=value".to_vec(), b"/home/bob/plan.md".to_vec()]
        );
    }

    /// The hook against a real client: the attachment the reporter added is
    /// replaced by the scrubbed copy, or dropped when the dump is unreadable.
    #[test]
    fn hook_replaces_or_drops_the_attachment() {
        use std::sync::{Arc, Mutex};

        struct Capture(Mutex<Vec<sentry::Envelope>>);
        impl sentry::Transport for Capture {
            fn send_envelope(&self, envelope: sentry::Envelope) {
                self.0.lock().unwrap().push(envelope);
            }
        }

        fn send(path: &Path) -> sentry::Envelope {
            let capture = Arc::new(Capture(Mutex::new(Vec::new())));
            let mut options = sentry::ClientOptions::default();
            options.dsn = Some("https://public@example.invalid/1".parse().unwrap());
            options.default_integrations = false;
            options.transport = Some(Arc::new(capture.clone()));
            let client = sentry::Client::with_options(options);

            let mut scope = sentry::Scope::default();
            // What the integration adds before calling the hook.
            scope.add_attachment(sentry::protocol::Attachment {
                buffer: b"UNSCRUBBED".to_vec(),
                filename: "x.dmp".into(),
                ty: Some(sentry::protocol::AttachmentType::Minidump),
                ..Default::default()
            });
            scrub_minidump_attachment(&mut scope, path);
            client.capture_event(
                sentry::protocol::Event {
                    level: sentry::Level::Fatal,
                    ..Default::default()
                },
                Some(&scope),
            );
            client.close(Some(std::time::Duration::from_secs(2)));
            let mut envelopes = capture.0.lock().unwrap();
            assert_eq!(envelopes.len(), 1);
            envelopes.pop().unwrap()
        }

        fn attachments(envelope: &sentry::Envelope) -> Vec<sentry::protocol::Attachment> {
            envelope
                .items()
                .filter_map(|item| match item {
                    sentry::protocol::EnvelopeItem::Attachment(a) => Some(a.clone()),
                    _ => None,
                })
                .collect()
        }

        fn tag(envelope: &sentry::Envelope) -> String {
            envelope
                .event()
                .unwrap()
                .tags
                .get("minidump.scrub")
                .cloned()
                .unwrap()
        }

        let dir =
            std::env::temp_dir().join(format!("tandem-minidump-scrub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let (dump, _) = build(&[(LINUX_ENVIRON, ENVIRON.to_vec())], ENVIRON);
        let good = dir.join("crash.dmp");
        std::fs::write(&good, &dump).unwrap();
        let envelope = send(&good);
        let sent = attachments(&envelope);
        assert_eq!(sent.len(), 1, "exactly the scrubbed dump is attached");
        assert_eq!(sent[0].filename, "crash.dmp");
        assert_eq!(sent[0].ty, Some(sentry::protocol::AttachmentType::Minidump));
        assert!(!contains(&sent[0].buffer, b"sk-live-abcdef"));
        assert_eq!(tag(&envelope), "scrubbed");

        let bad = dir.join("bad.dmp");
        std::fs::write(&bad, b"not a minidump at all, but long enough").unwrap();
        let envelope = send(&bad);
        assert!(
            attachments(&envelope).is_empty(),
            "an unparseable dump is dropped"
        );
        assert_eq!(tag(&envelope), "dropped: bad-signature");

        let envelope = send(&dir.join("missing.dmp"));
        assert!(attachments(&envelope).is_empty());
        assert_eq!(tag(&envelope), "dropped: unreadable");

        std::fs::remove_dir_all(&dir).ok();
    }
}
