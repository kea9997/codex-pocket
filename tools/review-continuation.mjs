// Retired: standalone resume conflicts with the actual desktop writer.
// Use tools/probe-desktop.mjs (read-only). Production sends only via the desktop owner.
console.error('RETIRED: standalone resume review is not supported. No action performed.');
process.exitCode = 1;
