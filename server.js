import express from 'express';
import WebTorrent from 'webtorrent';

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

const activeTorrents = new Map(); // torrentUrl -> torrent
const pendingAdds = new Map(); // torrentUrl -> Promise

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

function isAllowedTorrentUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.pathname.endsWith('.torrent');
  } catch {
    return false;
  }
}

async function addTorrent(torrentUrl) {
  const res = await fetch(torrentUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
  });
  if (!res.ok) throw new Error('No se pudo descargar el .torrent: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());

  if (buf.length < 20 || buf[0] !== 0x64 /* 'd' bencode dict */) {
    throw new Error('El archivo descargado no parece un .torrent válido (¿bloqueado por el hosting?)');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Timeout esperando metadata del torrent')); }
    }, 30000);

    try {
      client.add(buf, { destroyStoreOnDestroy: true }, (t) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(t); }
      });
    } catch (err) {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    }
  });
}

async function getOrAddTorrent(torrentUrl) {
  if (activeTorrents.has(torrentUrl)) {
    return activeTorrents.get(torrentUrl);
  }
  if (pendingAdds.has(torrentUrl)) {
    return pendingAdds.get(torrentUrl);
  }

  const promise = addTorrent(torrentUrl)
    .then((torrent) => {
      activeTorrents.set(torrentUrl, torrent);
      torrent.on('close', () => activeTorrents.delete(torrentUrl));
      return torrent;
    })
    .finally(() => pendingAdds.delete(torrentUrl));

  pendingAdds.set(torrentUrl, promise);
  return promise;
}

app.get('/health', (req, res) => res.json({ ok: true, torrents: activeTorrents.size }));

app.get('/stream', async (req, res) => {
  const torrentUrl = req.query.torrent;
  if (!torrentUrl || !isAllowedTorrentUrl(torrentUrl)) {
    return res.status(400).send('Parámetro "torrent" inválido o ausente (debe ser una URL https a un .torrent)');
  }

  try {
    const torrent = await getOrAddTorrent(torrentUrl);

    const file = torrent.files
      .filter(f => /\.(mp4|mkv|webm|avi|mov)$/i.test(f.name))
      .sort((a, b) => b.length - a.length)[0];

    if (!file) {
      return res.status(404).send('No se encontró un archivo de vídeo en este torrent');
    }

    const range = req.headers.range;
    const fileSize = file.length;

    res.setHeader('Content-Type', mimeForFile(file.name));
    res.setHeader('Accept-Ranges', 'bytes');

    if (!range) {
      res.setHeader('Content-Length', fileSize);
      file.createReadStream().pipe(res);
      return;
    }

    const match = range.match(/bytes=(\d*)-(\d*)/);
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
    if (end >= fileSize) end = fileSize - 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', end - start + 1);

    file.createReadStream({ start, end }).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error: ' + err.message);
  }
});

app.listen(PORT, () => console.log('MariFlix bridge listening on port ' + PORT));
