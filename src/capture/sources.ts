/**
 * Audio sources the offscreen document can capture from. Each one connects into the capture
 * AudioContext and says whether its audio must be played back (tab capture mutes the tab, so the
 * user would otherwise hear nothing).
 */

export interface ConnectedSource {
  node: AudioNode;
  /** Play this source to the speakers. True for tab audio: capturing it mutes the tab. */
  playback: boolean;
  /** The source as a live track, for engines that listen to a track (on-device Web Speech). */
  track: MediaStreamTrack | null;
  /** Releases the source (stops tracks, oscillators). */
  stop(): void;
}

export interface AudioSource {
  /** For status lines and logs. */
  readonly label: string;
  connect(context: AudioContext): Promise<ConnectedSource>;
}

/**
 * The audio of a browser tab, from a stream ID minted by `tabCapture.getMediaStreamId` in the
 * service worker. The ID is single-use and expires after a few seconds.
 */
export function tabAudioSource(streamId: string): AudioSource {
  return {
    label: 'tab audio',
    async connect(context) {
      // Chrome's tab-capture constraints predate the standard shape, so they aren't in the types.
      const constraints = {
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: false,
      } as unknown as MediaStreamConstraints;
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      return {
        node: context.createMediaStreamSource(stream),
        playback: true,
        track: stream.getAudioTracks()[0] ?? null,
        stop: () => {
          for (const track of stream.getTracks()) track.stop();
        },
      };
    },
  };
}

/**
 * A synthetic source: a looped buffer of 1 s of a 220 Hz tone then 1 s of exact silence, so the
 * pipeline sees speech-like bursts with pauses between them. Used by the e2e build (headless
 * Chromium has no tab audio to hear) and handy for trying engines without a video. Not played
 * back.
 */
export function toneSource(): AudioSource {
  return {
    label: 'test tone',
    async connect(context) {
      const rate = context.sampleRate;
      const buffer = new AudioBuffer({ length: rate * 2, sampleRate: rate, numberOfChannels: 1 });
      const data = buffer.getChannelData(0);
      for (let i = 0; i < rate; i++) data[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate);
      const node = new AudioBufferSourceNode(context, { buffer, loop: true });
      node.start();
      // Also as a track, like tab audio.
      const out = context.createMediaStreamDestination();
      node.connect(out);
      const track = out.stream.getAudioTracks()[0] ?? null;
      return {
        node,
        playback: false,
        track,
        stop: () => {
          node.stop();
          track?.stop();
        },
      };
    },
  };
}
