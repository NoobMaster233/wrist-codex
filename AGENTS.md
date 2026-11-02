# Agent entry point

Public source edition of ORBIT 0.4.3 for Xiaomi Smart Band 10 Pro,
M2551B1, firmware **3.101.043**. Start with README.md, then
docs/SETUP.md and docs/ARCHITECTURE.md.

## Work offline first

- Run npm ci, npm test, python scripts/test-native.py, python scripts/test-publication.py,
  python scripts/check-publication.py and python scripts/doctor.py.
- Tests must not connect to a phone, capture audio, send a Codex prompt or
  install anything. Hardware verification is a separate operation.
- Build native candidates with scripts/build-native.py and the local ARM GNU
  toolchain. No private build server is required.
- Pinned, previously device-tested modules live in resources/native/3.101.043/.
  A newly compiled module is a candidate, not a hardware-tested release.

## Device prerequisites

- Operate only on the owner's explicitly selected, paired band and phone.
  Verify M2551B1 / 3.101.043 before any native loading.
- Factory-channel auth is a per-device prerequisite. Import the owner's private
  JSON through configure-device.py; do not assume this repo can extract it from
  an unrooted official health app. Ask the owner for their authorized export if
  absent. Do not scrape another device or bypass pairing.
- Keep pairing keys, link keys, receipts, loader bundles, transcripts, logs and
  state in .local/. Never paste them into issues.
- The default ADB target is the phone's loopback listener and must be authorized.
  Never disable RSA authentication, root the phone, change bonding, stop
  MiWearCore, or change persistent debugging properties to force a connection.

## Deployment and recovery

- Follow docs/SETUP.md in order. Stop if a required receipt or state is uncertain.
- A new owner's first native load needs that owner's authorization. Authorization
  from the original development session does not transfer to a new device.
  Respect authorization already given in the current session.
- The public first-install helper is syntax/model checked; it has **not** been
  freshly validated on a second factory-reset band. State that limit.
- Never clear pending / once / healthy markers to make an operation retry.
  Never live-unload native modules or reflash firmware as a recovery shortcut.
- Reconnect the transport without replaying Shell commands or confirmed prompts.
  Preserve send journals, original transfer IDs and uncertain outcomes.
- Do not stop or restart an active Codex daemon for routine diagnosis. The
  current conversation may rely on it. Connect to the existing socket.
- First-install and recovery faces are maintenance tools. Keep daily watchfaces
  UI-only and restore the owner's chosen face afterward.

## Publication

- Do not add firmware images, SDK archives, private signatures, .local/,
  conversation screenshots or real microphone recordings to Git.
- Run python scripts/check-publication.py on staged files before push.
- MIT covers original code/assets. Dependencies keep their own licenses.
- Keep hardware evidence, offline tests and proposed behavior distinct.
