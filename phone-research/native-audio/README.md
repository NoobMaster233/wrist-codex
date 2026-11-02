# Firmware-bound native sources

These are this project's C implementations for M2551B1 / 3.101.043.
They use fixed firmware addresses and compile as ARM Thumb ET_REL modules.

- audio-service-043.c: owned capture task; idle until an explicit App request.
- shell-service-043.c / shell-wire.c: NSH requests, output and persisted intents.
- private-link-service-043.c / private-link-wire.c: authenticated private SPP.
- management-043.c: bounded private file operations and one-shot EXEC publication.
- capture-core.c / command-builder.c: portable state models and ABI checks.
- emulate-*.py: optional ARM emulation models. They require an owner's matching
  firmware input and emulator dependencies, which are not redistributed.

Use scripts/build-native.py with the local ARM GNU tools. Never interpret
successful compilation or emulation as device validation. See docs/VALIDATION.md.
