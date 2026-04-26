# Feedback sounds

Drop three short WAV files here. All **48 kHz, mono, 16-bit PCM** —
same format pytgcalls streams into the call:

| File | Played when | Suggested length |
| --- | --- | --- |
| `dial.wav` | The service starts dialing Santi (looped until he picks up) | 1–2 s, silenceable |
| `accept.wav` | The service auto-accepts an incoming call from Santi | 300–500 ms chime |
| `end.wav` | The service hangs up | 300 ms descending tone |

If a file is missing, the service falls back to 200 ms of silence so
pytgcalls always has something to stream.

## Generating quickly with ffmpeg

```bash
# 440 Hz ping, 300 ms, 48k/mono/s16le — a classic "accept" chime.
ffmpeg -f lavfi -i "sine=frequency=440:duration=0.3" \
    -ar 48000 -ac 1 -sample_fmt s16 accept.wav

# Dial tone loop — 2 s of 350+440 Hz, matches the US dial tone.
ffmpeg -f lavfi -i "sine=frequency=350:duration=2[a];sine=frequency=440:duration=2[b];[a][b]amerge=inputs=2" \
    -ac 1 -ar 48000 -sample_fmt s16 dial.wav

# End tone — a quick descending pair.
ffmpeg -f lavfi -i "sine=frequency=660:duration=0.15,sine=frequency=440:duration=0.15" \
    -ar 48000 -ac 1 -sample_fmt s16 end.wav
```

## Licensing

Don't drop copyrighted rings in here. Either synthesize them (as
above), record your own, or use a permissively-licensed sound pack
like [NASA's audio library](https://www.nasa.gov/audio-and-ringtones/)
or [kenney.nl](https://kenney.nl/assets?s=audio).
