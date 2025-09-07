// server/app.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const { spawn } = require('child_process'); // 🔹 para rodar yt-dlp

const ytSearch = require('yt-search');
const cors = require('cors');

const app = express();
const PORT = 3001;
const JOBS_DIR = path.join(__dirname, 'jobs'); // pasta para armazenar zips temporários
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

app.use(cors({ origin: [
  'https://ipatinga-downloader.vercel.app',
  'http://localhost:3001'
]})); 
app.use(express.json({ limit: '50mb' }));

// in-memory job registry
const jobs = new Map(); // jobId => { emitter, status, total, processed, filepath }

async function searchYouTube(query) {
  const r = await ytSearch(query);
  if (!r.videos || r.videos.length === 0) throw new Error('Vídeo não encontrado');
  return r.videos[0].url;
}

// 🔹 função helper para baixar MP3 com yt-dlp
function downloadWithYtDlp(url) {
  
  const pass = new PassThrough();
  
  const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES);
}

  const ytProcess = spawn('yt-dlp', [
    ...(fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : []),
    '-o', '-',             // saída no stdout
    '-f', 'bestaudio',
    '-x', '--audio-format', 'mp3',
    '--audio-quality', '128K',
    url
  ]);
  if (!url) {
  throw new Error("URL inválida para yt-dlp");
}



  ytProcess.stdout.pipe(pass);
  ytProcess.stderr.on('data', d => console.error('yt-dlp:', d.toString()));

  return { stream: pass, process: ytProcess };
}

// inicia o job: processa playlist e cria ZIP no disco, emitindo progresso
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

  try {
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const query = `${track.name} ${track.artists.map(a => a.name).join(' ')}`;

      emitter.emit('progress', { type: 'stage', stage: `buscando (${i+1}/${total})`, processed: i, total });
      let youtubeUrl;
      try {
        youtubeUrl = await searchYouTube(query);
      } catch (err) {
        console.warn(`Não encontrado: ${query}`, err.message);
        jobs.get(jobId).processed++;
        emitter.emit('progress', { type: 'skip', track: track.name, processed: jobs.get(jobId).processed, total });
        continue;
      }

      emitter.emit('progress', { type: 'stage', stage: `baixando/convertendo (${i+1}/${total})`, processed: i, total });

      const { stream, process } = downloadWithYtDlp(youtubeUrl);
      const safeName = `${track.name.replace(/[\/\\?%*:|"<>]/g, '_')}.mp3`;

      // append no zip
      archive.append(stream, { name: safeName });

      // espera yt-dlp terminar
      await new Promise((resolve, reject) => {
        process.on('exit', code => {
          if (code === 0) resolve();
          else reject(new Error(`yt-dlp falhou com código ${code}`));
        });
        process.on('error', reject);
      });

      jobs.get(jobId).processed++;
      emitter.emit('progress', { type: 'progress', processed: jobs.get(jobId).processed, total });
    }

    await archive.finalize();
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });

    jobs.get(jobId).status = 'done';
    emitter.emit('done', { downloadUrl: `/download/${jobId}`, filepath: zipPath });

    // cleanup após 10min
    setTimeout(() => {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      jobs.delete(jobId);
    }, 1000 * 60 * 10);

  } catch (err) {
    console.error('Erro no job:', err);
    jobs.get(jobId).status = 'error';
    emitter.emit('error', { message: err.message || String(err) });
  }
}

// endpoint para iniciar o job
app.post('/download/start', (req, res) => {
  const { tracks } = req.body;
  if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: 'tracks inválido' });
  }

  const jobId = uuidv4();
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter, status: 'pending', total: 0, processed: 0, filepath: null });

  res.json({ jobId });

  startJob(jobId, tracks).catch(err => console.error('startJob error:', err));
});

// SSE endpoint para progresso
app.get('/events/:jobId', (req, res) => {
  const id = req.params.jobId;
  const job = jobs.get(id);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (ev, data) => {
    try {
      res.write(`event: ${ev}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
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

// endpoint para baixar o zip pronto
app.get('/download/:jobId', (req, res) => {
  const id = req.params.jobId;
  const job = jobs.get(id);
  if (!job || job.status !== 'done' || !job.filepath) {
    return res.status(404).json({ error: 'Job não encontrado / não pronto' });
  }

  const stat = fs.statSync(job.filepath);
  res.setHeader('Content-Disposition', `attachment; filename="playlist-${id}.zip"`);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', stat.size);

  fs.createReadStream(job.filepath).pipe(res);
});

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));