// Adds the soundtrack to the promo video: an ElevenLabs voiceover and an optional music bed. Voice, model,
// lines and music are in store-assets/promo/voiceover.json: each line's "at" is the second it starts in the
// video and "until" is when its beat ends, so a line that would run into the next beat is refused.
// Each line is synthesised once and cached in store-assets/promo/voice/ (the file name carries a hash of
// its text and the voice settings), so re-runs only pay for lines that changed. The clips are placed at
// their times over the silent render (store-assets/promo/video-silent.mp4, from render-video.js),
// loudness-normalised, and muxed → store-assets/promo-video-30s.mp4.
//
// Music: put the licensed track at store-assets/promo/<music.file> (kept out of git: the license covers the
// finished video, not sharing the track). It starts `start` seconds into the track, is brought to
// `level_lufs`, faded in and out, and ducked under the voice. Without the file, the voice is mixed alone.
//
//   ELEVENLABS_API_KEY=… node scripts/voiceover.js            synthesise what's missing, then mix
//   ELEVENLABS_API_KEY=… node scripts/voiceover.js --voices   list the voices on your account
//
// The key is only needed when a clip has to be (re)synthesised. Needs ffmpeg and ffprobe on PATH.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ASSETS = path.join(__dirname, '..', 'store-assets');
const PROMO = path.join(ASSETS, 'promo');
const VOICE_DIR = path.join(PROMO, 'voice');
const SILENT = path.join(PROMO, 'video-silent.mp4');
const OUT = path.join(ASSETS, 'promo-video-30s.mp4');
const API = 'https://api.elevenlabs.io/v1';

function apiKey() {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error('Set ELEVENLABS_API_KEY to your ElevenLabs API key.');
  return process.env.ELEVENLABS_API_KEY;
}

async function listVoices() {
  const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': apiKey() } });
  if (!res.ok) throw new Error(`GET /voices: ${res.status} ${await res.text()}`);
  for (const v of (await res.json()).voices) console.log(`${v.voice_id}  ${v.name}  (${Object.values(v.labels || {}).join(', ')})`);
}

async function synthesise(cfg, i, file) {
  const res = await fetch(`${API}/text-to-speech/${cfg.voice_id}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: cfg.lines[i].text, model_id: cfg.model_id, voice_settings: cfg.voice_settings,
      // the neighbouring lines keep the delivery continuous across separately generated clips
      previous_text: cfg.lines[i - 1]?.text, next_text: cfg.lines[i + 1]?.text,
    }),
  });
  if (!res.ok) throw new Error(`text-to-speech (line ${i + 1}): ${res.status} ${await res.text()}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

// Integrated loudness (LUFS) of [start, start+len) of a file: loudnorm's measurement, printed as JSON on stderr.
function loudness(file, start, len) {
  const { stderr } = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(start), '-t', String(len), '-i', file,
    '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)).input_i);
}

async function main() {
  if (process.argv.includes('--voices')) return listVoices();
  const cfg = JSON.parse(fs.readFileSync(path.join(PROMO, 'voiceover.json'), 'utf8'));
  if (!fs.existsSync(SILENT)) throw new Error('No silent render yet: run node scripts/render-video.js first.');
  fs.mkdirSync(VOICE_DIR, { recursive: true });

  const clips = [];
  for (const [i, line] of cfg.lines.entries()) {
    const hash = crypto.createHash('sha1').update(JSON.stringify([cfg.voice_id, cfg.model_id, cfg.voice_settings, line.text])).digest('hex').slice(0, 10);
    const file = path.join(VOICE_DIR, `${i + 1}-${hash}.mp3`);
    if (!fs.existsSync(file)) await synthesise(cfg, i, file);
    const ends = line.at + duration(file);
    console.log(`${line.at.toFixed(1)}–${ends.toFixed(1)} s (beat ends ${line.until})${ends > line.until ? '  TOO LONG' : ''}  "${line.text}"`);
    clips.push({ file, at: line.at, over: ends > line.until });
  }
  const used = new Set(clips.map((c) => path.basename(c.file)));
  for (const f of fs.readdirSync(VOICE_DIR)) if (!used.has(f)) fs.rmSync(path.join(VOICE_DIR, f)); // clips of edited lines

  const over = clips.filter((c) => c.over).length;
  if (over) throw new Error(`${over} line(s) run past their beat: shorten the text or raise voice_settings.speed in voiceover.json.`);

  // Voice: each clip at its time, mixed, normalised to -16 LUFS (web video), padded to the video's length.
  const len = duration(SILENT), n = clips.length;
  const inputs = ['-i', SILENT, ...clips.flatMap((c) => ['-i', c.file])];
  let graph = clips.map((c, i) => `[${i + 1}:a]adelay=delays=${Math.round(c.at * 1000)}:all=1[v${i}];`).join('') +
    `${clips.map((_, i) => `[v${i}]`).join('')}amix=inputs=${n}:normalize=0,aformat=sample_rates=48000:channel_layouts=stereo,` +
    `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad=whole_dur=${len}`;
  const music = cfg.music && { start: 0, level_lufs: -26, fade_in: 0.4, fade_out: 2.5, ...cfg.music, path: path.join(PROMO, cfg.music.file) };
  let what = 'voiceover';
  if (music && fs.existsSync(music.path)) {
    // One fixed gain brings the section to level_lufs (loudnorm itself would flatten the track's build),
    // and a compressor keyed on the voice ducks the bed while someone is speaking.
    const gain = music.level_lufs - loudness(music.path, music.start, len);
    inputs.push('-i', music.path);
    graph += `,asplit=2[voice][key];` +
      `[${n + 1}:a]atrim=start=${music.start}:duration=${len},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,` +
      `volume=${gain.toFixed(2)}dB,afade=t=in:d=${music.fade_in},afade=t=out:st=${len - music.fade_out}:d=${music.fade_out}[bed];` +
      `[bed][key]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400[ducked];` +
      `[voice][ducked]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.84[mix]`;
    what = `voiceover + music (${cfg.music.file})`;
  } else {
    if (music) console.log(`No ${cfg.music.file} in store-assets/promo/ yet: mixing the voice alone.`);
    graph += '[mix]';
  }
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', graph, '-map', '0:v', '-map', '[mix]',
    '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  console.log(`${path.relative(path.join(ASSETS, '..'), OUT)}: video + ${what}`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
