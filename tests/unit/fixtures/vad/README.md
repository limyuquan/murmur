# Speech detector fixtures

Short clips for `tests/unit/pipeline.silero.test.ts`: 16 kHz, mono, 16-bit PCM WAV, 3 s each.
Silence and noise are made in the test.

| File | What | Source | Licence |
|---|---|---|---|
| `speech.wav` | One speaker reading a sentence (English), from 0.6 s to 3.6 s of the recording, level-normalised | [FLEURS](https://huggingface.co/datasets/google/fleurs) (Google), `en_us` dev split, sentence id 1513, file `822694990038496232.wav`. The sentence read is from FLORES-101 | Audio [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the FLORES-101 sentence [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `music.wav` | Dance music, no voice in this part: 60 s to 63 s of the track | "DJ Smallest - Hard" by Smallest, [Jamendo track 1225197](https://www.jamendo.com/track/1225197) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |

Changes: cut, downmixed to mono and resampled to 16 kHz with ffmpeg; the speech clip's level was
raised by 21.8 dB.
