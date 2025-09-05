// server/app.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const archiver = require('archiver');
const { PassThrough } = require('stream');

const ytdl = require('@distube/ytdl-core'); // fork mais estável
const ytSearch = require('yt-search');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const cors = require('cors');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = 3001;
const JOBS_DIR = path.join(__dirname, 'jobs'); // pasta para armazenar zips temporários
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

app.use(cors({ origin: ['https://ipatinga-downloader-rops-avg4fa0bh-kauasantosdevs-projects.vercel.app'
  ,'http://localhost:3001'] })); // ajuste conforme front
app.use(express.json({ limit: '50mb' }));

// in-memory job registry
const jobs = new Map(); // jobId => { emitter, status, total, processed, filepath }

async function searchYouTube(query) {
  const r = await ytSearch(query);
  if (!r.videos || r.videos.length === 0) throw new Error('Vídeo não encontrado');
  return r.videos[0].url;
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
        // se não encontrar, marca como pulada e segue
        console.warn(`Não encontrado: ${query}`, err.message);
        jobs.get(jobId).processed++;
        emitter.emit('progress', { type: 'skip', track: track.name, processed: jobs.get(jobId).processed, total });
        continue;
      }

      emitter.emit('progress', { type: 'stage', stage: `convertendo (${i+1}/${total})`, processed: i, total });

      // converte para mp3 via ffmpeg em um PassThrough e adiciona ao zip
      const audioStream = ytdl(youtubeUrl, { quality: 'highestaudio' });
      const pass = new PassThrough();

      // append antes para que archiver "reserve" o nome; o conteúdo virá do pass
      const safeName = `${track.name.replace(/[\/\\?%*:|"<>]/g, '_')}.mp3`;
      archive.append(pass, { name: safeName });

      // converter e pipe para pass; aguardamos fim da conversão para considerar processado
      await new Promise((resolve, reject) => {
        ffmpeg(audioStream)
          .audioBitrate(128)
          .format('mp3')
          .on('error', (err) => {
            console.error('Erro no FFmpeg (track):', safeName, err.message || err);
            // finaliza pass para não travar zip
            pass.end();
            reject(err);
          })
          .on('end', () => {
            // console.log('ffmpeg end for', safeName);
            resolve();
          })
          .pipe(pass, { end: true });
      });

      // marcou 1 track processada
      jobs.get(jobId).processed++;
      emitter.emit('progress', { type: 'progress', processed: jobs.get(jobId).processed, total });
    }

    // finalize zip
    await archive.finalize();

    // aguardar fechamento do stream de output
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });

    jobs.get(jobId).status = 'done';
    emitter.emit('done', { downloadUrl: `/download/${jobId}`, filepath: zipPath });

    // opcional: depois de X tempo remover o arquivo (cleanup). aqui removemos só depois de 10 minutos:
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

  // responde com jobId
  res.json({ jobId });

  // inicia processamento async (não bloqueia resposta)
  startJob(jobId, tracks).catch(err => {
    console.error('startJob error:', err);
  });
});

// SSE endpoint para progresso
app.get('/events/:jobId', (req, res) => {
  const id = req.params.jobId;
  const job = jobs.get(id);
  if (!job) {
    return res.status(404).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (ev, data) => {
    try {
      res.write(`event: ${ev}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      /* ignore */
    }
  };

  // send initial status
  send('status', { status: job.status, processed: job.processed, total: job.total });

  const onProgress = (data) => send('progress', data);
  const onDone = (data) => {
    send('done', data);
    // depois de done fechamos a conexão
    res.write('event: close\n');
    res.write('data: {}\n\n');
    res.end();
  };
  const onError = (data) => {
    send('error', data);
    res.end();
  };

  job.emitter.on('progress', onProgress);
  job.emitter.once('done', onDone);
  job.emitter.once('error', onError);

  // se cliente fechar, removemos listeners
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
  if (!job || job.status !== 'done' || !job.filepath) return res.status(404).json({ error: 'Job não encontrado / não pronto' });

  const stat = fs.statSync(job.filepath);
  res.setHeader('Content-Disposition', `attachment; filename="playlist-${id}.zip"`);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(job.filepath);
  stream.pipe(res);
});

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
