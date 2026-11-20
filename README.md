# PixelWave v5
Static client-only acoustic image transfer. Host all files together on HTTPS. Two devices must use v5.

- Minimal send/receive interface; settings under gear.
- JPEG compression on device, 192 px default.
- Packetized 4-FSK at 16ms/symbol (125 raw bit/s, ~1.5x v4's raw symbol rate; actual payload speed varies).
- Hamming(12,8) single-bit correction, per-packet CRC32 and file CRC32.
- Systematic GF(256) Reed–Solomon **erasure coding** across 8 data shards plus 2/3/4 parity shards. A CRC-invalid packet is discarded; any 8 of the 11 shards in a group suffice with default parity. This does not directly correct arbitrary byte errors within a CRC-accepted shard.
- Packet interleaving across groups and configurable repeat transmission.
- AudioWorklet capture where available, ScriptProcessor fallback.
- Progressive display best-effort: JPEG partial decoding depends on browser, full validated image appears on completion.
- Offline PWA cache and WAV export/import.
- Legacy Robot36 remains separate and is not part of v5 RS mode.

Known limitations: physical handset-to-handset performance not measured; this is an experimental build. No bidirectional ACK/ARQ. Audio timing and decoder search may fail in noise, and microphone processing can distort tones. The transmitter requires an active foreground tab. Test with WAV first, then real devices. The first WAV packet is metadata, repeated with each pass; receiving it is necessary to finish the file.
