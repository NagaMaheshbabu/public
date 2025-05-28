// tileCache.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { LRUCache } = require('lru-cache');

const TILE_CACHE_DIR = path.join(__dirname, 'tile-cache');

const tileCache = new LRUCache({
  max: 1000,
  ttl: 1000 * 60 * 5 // 5 minutes
});

function getTileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function getTilePath(z, x, y) {
  return path.join(TILE_CACHE_DIR, z, x, `${y}.mvt.gz`);
}

function getTileFromCache(z, x, y) {
  const key = getTileKey(z, x, y);
  if (tileCache.has(key)) {
    return tileCache.get(key); // From memory
  }

  const diskPath = getTilePath(z, x, y);
  if (fs.existsSync(diskPath)) {
    const data = fs.readFileSync(diskPath);
    tileCache.set(key, data); // Store in disk
    return data;
  }
  return null;
}

function storeTileToCache(z, x, y, compressedTileBuffer) {
  const key = getTileKey(z, x, y);
  tileCache.set(key, compressedTileBuffer);
  const filePath = getTilePath(z, x, y);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, compressedTileBuffer);
}

function deleteTile(z, x, y) {
  const tilePath = path.join(TILE_CACHE_DIR, `${z}`, `${x}`, `${y}.mvt.gz`);
  fs.unlink(tilePath, (err) => {
    if (err) {
      if (err.code === 'ENOENT') {
        console.warn(`Tile does not exist: ${tilePath}`);
      } else {
        console.error(`Error deleting tile: ${tilePath}`, err);
      }
    } else {
      const key = getTileKey(z, x, y);
      tileCache.delete(key);
    }
  });
}

module.exports = {
  getTileFromCache,
  storeTileToCache,
  deleteTile
};
