import express from 'express';
import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TORRENTS_DIR = path.join(__dirname, 'torrents');

fs.mkdirSync('/tmp/mariflix-downloads', { recursive: true });

const app = express();
const client = new WebTorrent();
const PORT = process.env.PORT || 3000;

// Sin esto, cualquier fallo al parsear un torrent tira abajo todo el proceso Node.
client.on('error', (err) => {
  console.error('WebTorrent client error:', err && err.message);
});

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  next();
});

const activeTorrents = new Map(); // relPath -> torrent
const pendingAdds = new Map(); // relPath -> Promise

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
};

function mimeForFile(name) {
  const ext = name.split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// --- Catálogo (lee la carpeta torrents/ local) ---

function listTorrentFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.torrent'))
    .map(f => ({ name: path.parse(f).name, file: f }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function hasTorrentFiles(dir) {
  return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.toLowerCase().endsWith('.torrent'));
}

function buildCatalog() {
  const catalog = { movies: [], series: [] };
  if (!fs.existsSync(TORRENTS_DIR)) return catalog;

  for (const entry of fs.readdirSync(TORRENTS_DIR)) {
    const full = path.join(TORRENTS_DIR, entry);
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      const series = { name: entry, seasons: [] };

      if (hasTorrentFiles(full)) {
        series.seasons.push({
          name: 'Temporada 1',
          path: entry,
          episodes: listTorrentFiles(full),
        });
      }

      for (const sub of fs.readdirSync(full)) {
        const subFull = path.join(full, sub);
        if (fs.statSync(subFull).isDirectory()) {
          series.seasons.push({
            name: sub,
            path: entry + '/' + sub,
            episodes: listTorrentFiles(subFull),
          });
        }
      }

      if (series.seasons.length) catalog.series.push(series);
    } else if (entry.toLowerCase().endsWith('.torrent')) {
      catalog.movies.push({ name: path.parse(entry).name, file: entry });
    }
  }

  catalog.movies.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  catalog.series.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return catalog;
}

app.get('/catalog', (req, res) => {
  res.json(buildCatalog());
});

// --- Streaming ---

function safeRelPath(relPath) {
  const normalized = path.normalize(relPath).replace(/^([./\\])+/, '');
  const full = path.join(TORRENTS_DIR, normalized);
  if (!full.startsWith(TORRENTS_DIR)) return null;
  if (!full.toLowerCase().endsWith('.torrent')) return null;
  return { normalized, full };
}

async function addTorrentFromDisk(relPath) {
  const resolved = safeRelPath(relPath);
  if (!resolved) throw new Error('Ruta de torrent inválida');
  if (!fs.existsSync(resolved.full)) throw new Error('Archivo .torrent no encontrado: ' + relPath);

  const buf = fs.readFileSync(resolved.full);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Timeout esperando metadata del torrent')); }
    }, 30000);

    try {
      client.add(buf, { path: '/tmp/mariflix-downloads' }, (t) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(t); }
      });
    } catch (err) {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    }
  });
}

async function getOrAddTorrent(relPath) {
  if (activeTorrents.has(relPath)) return activeTorrents.get(relPath);
  if (pendingAdds.has(relPath)) return pendingAdds.get(relPath);

  const promise = addTorrentFromDisk(relPath)
    .then((torrent) => {
      activeTorrents.set(relPath, torrent);
      torrent.on('close', () => activeTorrents.delete(relPath));
      return torrent;
    })
    .finally(() => pendingAdds.delete(relPath));

  pendingAdds.set(relPath, promise);
  return promise;
}

app.get('/health', (req, res) => res.json({ ok: true, torrents: activeTorrents.size }));

app.get('/stream', async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) {
    return res.status(400).send('Parámetro "path" ausente (ruta relativa al .torrent dentro de /torrents)');
  }

  try {
    const torrent = await getOrAddTorrent(relPath);

    const file = torrent.files
      .filter(f => /\.(mp4|mkv|webm|avi|mov)$/i.test(f.name))
      .sort((a, b) => b.length - a.length)[0];

    if (!file) {
      return res.status(404).send('No se encontró un archivo de vídeo en este torrent');
    }

    // Remuxeamos a fragmented MP4 y recodificamos el audio a AAC (el vídeo se copia tal
    // cual, sin recodificar, para no gastar CPU). Esto arregla el audio mudo cuando el
    // archivo original trae AC3/DTS, que los navegadores no saben decodificar.
    // Como el tamaño de salida no se conoce de antemano, no soportamos Range aquí:
    // no hay salto preciso en la barra de progreso, pero sí hay audio.
    res.setHeader('Content-Type', 'video/mp4');

    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1',
    ]);

    ffmpeg.stderr.on('data', () => {}); // silenciar logs de ffmpeg, no son errores necesariamente

    const source = file.createReadStream();
    source.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);

    const cleanup = () => {
      source.destroy();
      ffmpeg.kill('SIGKILL');
    };
    req.on('close', cleanup);
    ffmpeg.on('error', (err) => {
      console.error('ffmpeg error:', err.message);
      cleanup();
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

app.listen(PORT, () => console.log('MariFlix bridge listening on port ' + PORT));
