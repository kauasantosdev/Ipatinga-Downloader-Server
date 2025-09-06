const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const pLimit = require('p-limit');
const ytSearch = require('yt-search');
const cors = require('cors');

const app = express();
const PORT = 3001;
const JOBS_DIR = path.join(__dirname, 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

app.use(cors({ origin: [
  'https://ipatinga-downloader-rops-avg4fa0bh-kauasantosdevs-projects.vercel.app',
  'http://localhost:3001'
]}));
app.use(express.json({ limit: '50mb' }));

const jobs = new Map();

async function searchYouTube(query) {
  const r = await ytSearch(query);
  if (!r.videos || r.videos.length === 0) throw new Error('Vídeo não encontrado');
  return r.videos[0].url;
}

function downloadWithYtDlp(url) {
  const pass = new PassThrough();
  if (!url) throw new Error("URL inválida para yt-dlp");
  const ytProcess = spawn('yt-dlp', [
    '-o', '-',
    '-f', 'bestaudio',
    '-x', '--audio-format', 'mp3',
    '--audio-quality', '128K',
    url
  ]);
  ytProcess.stdout.pipe(pass);
  ytProcess.stderr.on('data', d => console.error('yt-dlp:', d.toString()));
  return { stream: pass, process: ytProcess };
}

async function startJob(jobId, tracks) {
  const emitter = jobs.get(jobId).emitter;
  const zipPath = path.join(JOBS_DIR, `${jobId}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(output);

  const total = tracks.length;
  jobs.get(jobId).total = total;
  jobs.get(jobId).processed = 0;
  jobs.get(jobId).filepath = zipPath;

  const limit = pLimit(2);

  const tasks = tracks.map((track, i) => limit(async () => {
    const query = `${track.name} ${track.artists.map(a => a.name).join(' ')}`;
    emitter.emit('progress', { type: 'stage', stage: `buscando (${i+1}/${total})`, processed: i, total });
    let youtubeUrl;
    try {
      youtubeUrl = await searchYouTube(query);
    } catch (err) {
      jobs.get(jobId).processed++;
      emitter.emit('progress', { type: 'skip', track: track.name, processed: jobs.get(jobId).processed, total });
      return;
    }

    emitter.emit('progress', { type: 'stage', stage: `baixando/convertendo (${i+1}/${total})`, processed: i, total });
    const { stream, process } = downloadWithYtDlp(youtubeUrl);
    const safeName = `${track.name.replace(/[\/\\?%*:|"<>]/g, '_')}.mp3`;
    archive.append(stream, { name: safeName });

    await new Promise((resolve, reject) => {
      process.on('exit', code => code === 0 ? resolve() : reject(new Error(`yt-dlp falhou com código ${code}`)));
      process.on('error', reject);
    });

    jobs.get(jobId).processed++;
    emitter.emit('progress', { type: 'progress', processed: jobs.get(jobId).processed, total });
  }));

  await Promise.all(tasks);

  await archive.finalize();
  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
  });

  jobs.get(jobId).status = 'done';
  emitter.emit('done', { downloadUrl: `/download/${jobId}`, filepath: zipPath });

  setTimeout(() => {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    jobs.delete(jobId);
  }, 1000 * 60 * 10);
}

app.post('/download/start', (req, res) => {
  const { tracks } = req.body;
  if (!tracks || !Array.isArray(tracks) || tracks.length === 0) return res.status(400).json({ error: 'tracks inválido' });

  const jobId = uuidv4();
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter, status: 'pending', total: 0, processed: 0, filepath: null });

  res.json({ jobId });

  startJob(jobId, tracks).catch(err => console.error('startJob error:', err));
});

app.get('/events/:jobId', (req, res) => {
  const id = req.params.jobId;
  const job = jobs.get(id);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (ev, data) => {
    try { res.write(`event: ${ev}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  send('status', { status: job.status, processed: job.processed, total: job.total });

  const onProgress = (data) => send('progress', data);
  const onDone = (data) => { send('done', data); res.end(); };
  const onError = (data) => { send('error', data); res.end(); };

  job.emitter.on('progress', onProgress);
  job.emitter.once('done', onDone);
  job.emitter.once('error', onError);

  req.on('close', () => {
    job.emitter.off('progress', onProgress);
    job.emitter.off('done', onDone);
    job.emitter.off('error', onError);
  });
});

app.get('/download/:jobId', (req, res) => {
  const id = req.params.jobId;
  const job = jobs.get(id);
  if (!job || job.status !== 'done' || !job.filepath) return res.status(404).json({ error: 'Job não encontrado / não pronto' });

  const stat = fs.statSync(job.filepath);
  res.setHeader('Content-Disposition', `attachment; filename="playlist-${id}.zip"`);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', stat.size);

  fs.createReadStream(job.filepath).pipe(res);
});

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
