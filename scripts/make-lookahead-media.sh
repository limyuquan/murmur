#!/usr/bin/env bash
# Regenerates the synthetic media for the lookahead tests (ffmpeg 6+). Everything is made from
# ffmpeg's own generators: tone bursts at known times, a solid-colour picture. No recordings.
#
#   scripts/make-lookahead-media.sh
#
# Page fixtures (tests/fixtures/pages/lookahead/): a 20 s clip as HLS (fMP4, separate audio
# rendition), DASH (fMP4) and a progressive MP4 with its index at the end. Opus audio and VP9
# video, because Playwright's Chromium has no AAC or H.264.
# Unit fixtures (tests/unit/fixtures/lookahead/): short AAC and Opus clips in the containers the
# demuxers read.
set -euo pipefail
cd "$(dirname "$0")/.."
PAGES=tests/fixtures/pages/lookahead
UNIT=tests/unit/fixtures/lookahead
rm -rf "$PAGES" "$UNIT"
mkdir -p "$PAGES/hls" "$PAGES/dash-mp4" "$PAGES/dash-webm" "$UNIT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Bursts of a 330 Hz tone (start-end, seconds); silence between. tests/e2e/lookahead.spec.ts
# lists the same times.
BURSTS="between(t,1,2)+between(t,4,5.5)+between(t,8,9)+between(t,11.5,13)+between(t,15,16)+between(t,18,19)"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "aevalsrc='0.4*sin(2*PI*330*t)*gt(${BURSTS},0)':s=48000:d=20" \
  -f lavfi -i "color=c=0x2a4d69:s=160x90:d=20:r=10" \
  -c:a libopus -b:a 24k -ac 1 -c:v libvpx-vp9 -b:v 20k -g 20 -row-mt 1 -deadline realtime \
  "$TMP/src.mkv"

# HLS: video and audio as separate renditions (so the player makes an audio SourceBuffer).
ffmpeg -hide_banner -loglevel error -y -i "$TMP/src.mkv" \
  -map 0:v -map 0:a -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init_%v.mp4 \
  -hls_segment_filename "$PAGES/hls/seg_%v_%03d.m4s" \
  -var_stream_map "v:0,agroup:aud a:0,agroup:aud,default:yes" \
  "$PAGES/hls/stream_%v.m3u8"
# ffmpeg leaves the video variant out of its master playlist when copying: write it here.
cat > "$PAGES/hls/master.m3u8" <<'M3U8'
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="stream_1.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=60000,RESOLUTION=160x90,CODECS="vp09.00.10.08,opus",AUDIO="aud"
stream_0.m3u8
M3U8

# DASH, in fMP4 (dash.js) and in WebM (Shaka; WebM audio as some big sites send it).
ffmpeg -hide_banner -loglevel error -y -i "$TMP/src.mkv" \
  -map 0:v -map 0:a -c copy -f dash -dash_segment_type mp4 -seg_duration 2 -use_template 1 \
  -use_timeline 0 -init_seg_name 'init_$RepresentationID$.mp4' \
  -media_seg_name 'seg_$RepresentationID$_$Number%03d$.m4s' "$PAGES/dash-mp4/manifest.mpd"
ffmpeg -hide_banner -loglevel error -y -i "$TMP/src.mkv" \
  -map 0:v -map 0:a -c copy -f dash -dash_segment_type webm -seg_duration 2 -use_template 1 \
  -use_timeline 0 -init_seg_name 'init_$RepresentationID$.webm' \
  -media_seg_name 'seg_$RepresentationID$_$Number%03d$.webm' "$PAGES/dash-webm/manifest.mpd"

# Progressive MP4, index (moov) at the end, as many encoders leave it.
ffmpeg -hide_banner -loglevel error -y -i "$TMP/src.mkv" -c copy -f mp4 "$PAGES/progressive.mp4"

# Unit fixtures: 3 s, two bursts (0.5-1.0, 2.0-2.5).
UB="between(t,0.5,1)+between(t,2,2.5)"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "aevalsrc='0.4*sin(2*PI*440*t)*gt(${UB},0)':s=44100:d=3" \
  -c:a aac -b:a 48k -ac 2 -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 500000 "$UNIT/aac-frag.mp4"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "aevalsrc='0.4*sin(2*PI*440*t)*gt(${UB},0)':s=48000:d=3" \
  -c:a libopus -b:a 24k -ac 1 -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 500000 "$UNIT/opus-frag.mp4"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "aevalsrc='0.4*sin(2*PI*440*t)*gt(${UB},0)':s=48000:d=3" \
  -c:a libopus -b:a 24k -ac 1 -cluster_time_limit 500 -f webm "$UNIT/opus.webm"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "aevalsrc='0.4*sin(2*PI*440*t)*gt(${UB},0)':s=44100:d=3" \
  -f lavfi -i "color=c=black:s=64x36:d=3:r=5" \
  -c:a aac -b:a 48k -ac 1 -c:v libvpx-vp9 -b:v 10k -f mp4 "$UNIT/aac-progressive.mp4"
du -sh "$PAGES"/* "$UNIT"
