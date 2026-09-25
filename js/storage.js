/*
 * Persistence: autosave to IndexedDB (when the browser allows it) and
 * .collage project files (a small JSON header followed by the original photo files).
 */
(function () {
  'use strict';

  const S = { ok: false, db: null };
  const DB_NAME = 'photo-collage';

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function tx(store, mode) {
    return S.db.transaction(store, mode).objectStore(store);
  }

  S.open = async () => {
    try {
      if (!window.indexedDB) return false;
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      S.db = await req(r);
      S.ok = true;
    } catch (e) {
      console.warn('Autosave unavailable', e);
      S.ok = false;
    }
    return S.ok;
  };

  async function safe(fn, fallback) {
    if (!S.ok) return fallback;
    try {
      return await fn();
    } catch (e) {
      console.warn('Storage error', e);
      return fallback;
    }
  }

  // rec: {id, name, w, h, blob, preview, thumb}
  S.putPhoto = (rec) => safe(() => req(tx('photos', 'readwrite').put(rec)));
  S.deletePhoto = (id) => safe(() => req(tx('photos', 'readwrite').delete(id)));
  S.allPhotos = () => safe(() => req(tx('photos', 'readonly').getAll()), []);
  S.saveState = (state) => safe(() => req(tx('meta', 'readwrite').put(state, 'state')));
  S.loadState = () => safe(() => req(tx('meta', 'readonly').get('state')), null);
  S.clear = () =>
    safe(async () => {
      await req(tx('photos', 'readwrite').clear());
      await req(tx('meta', 'readwrite').clear());
    });

  // ---- Project files -------------------------------------------------------

  const MAGIC = 'COLLAGE1';

  // files: [{id, blob}]
  S.buildProject = (state, files) => {
    const header = JSON.stringify({
      app: 'photo-collage',
      version: 1,
      state,
      files: files.map((f) => ({ id: f.id, size: f.blob.size, type: f.blob.type })),
    });
    const hb = new TextEncoder().encode(header);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, hb.length);
    return new Blob([MAGIC, len, hb, ...files.map((f) => f.blob)], { type: 'application/octet-stream' });
  };

  S.readProject = async (file) => {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const magic = new TextDecoder().decode(head.slice(0, 8));
    if (magic !== MAGIC) throw new Error('This is not a collage project file.');
    const len = new DataView(head.buffer).getUint32(8);
    const header = JSON.parse(await file.slice(12, 12 + len).text());
    let off = 12 + len;
    const files = header.files.map((f) => {
      const blob = file.slice(off, off + f.size, f.type);
      off += f.size;
      return { id: f.id, blob };
    });
    return { state: header.state, files };
  };

  // ---- Print resolution metadata ------------------------------------------

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Write the DPI into the file so print shops and Preview show the right physical size.
  S.withDpi = async (blob, dpi) => {
    try {
      const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
      if (head[0] === 0xff && head[1] === 0xd8) {
        // JPEG: patch the JFIF APP0 density fields if present.
        const isJfif = head[2] === 0xff && head[3] === 0xe0 && String.fromCharCode(...head.slice(6, 10)) === 'JFIF';
        if (!isJfif) return blob;
        const patched = head.slice(0, 18);
        patched[13] = 1; // dots per inch
        patched[14] = dpi >> 8; patched[15] = dpi & 0xff;
        patched[16] = dpi >> 8; patched[17] = dpi & 0xff;
        return new Blob([patched, blob.slice(18)], { type: blob.type });
      }
      if (head[0] === 0x89 && String.fromCharCode(...head.slice(1, 4)) === 'PNG') {
        // PNG: insert a pHYs chunk right after IHDR (which always ends at byte 33).
        const ppm = Math.round(dpi / 0.0254);
        const chunk = new Uint8Array(21);
        const dv = new DataView(chunk.buffer);
        dv.setUint32(0, 9);
        chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
        dv.setUint32(8, ppm);
        dv.setUint32(12, ppm);
        chunk[16] = 1;
        dv.setUint32(17, crc32(chunk.slice(4, 17)));
        return new Blob([blob.slice(0, 33), chunk, blob.slice(33)], { type: blob.type });
      }
    } catch (e) {
      console.warn('Could not set DPI', e);
    }
    return blob;
  };

  window.CollageStorage = S;
})();
