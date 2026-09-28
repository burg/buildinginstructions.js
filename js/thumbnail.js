/**
 * thumbnail.js - Renders LDraw model thumbnails as data:url images.
 *
 * Uses a single offscreen canvas + three.js renderer to render each model,
 * captures toDataURL(), and sets it on an <img> element. Renderer is
 * disposed between renders to keep memory low.
 *
 * Thumbnails are cached in IndexedDB so subsequent page loads skip rendering.
 *
 * Usage: renderAllThumbnails('.trial-thumb-img', 200)
 * Elements need data-model="models/path.ldr" attribute.
 */

// BJB> IndexedDB cache for rendered thumbnails
const ThumbCache = {
    DB_NAME: 'lego-thumb-cache',
    STORE_NAME: 'thumbnails',
    DB_VERSION: 1,
    _db: null,

    open() {
        return new Promise((resolve, reject) => {
            if (this._db) { resolve(this._db); return; }
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'key' });
                }
            };
            req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
            req.onerror = (e) => { console.warn('[thumb-cache] open failed:', e); resolve(null); };
        });
    },

    async get(modelPath, size) {
        const db = await this.open();
        if (!db) return null;
        const key = `${modelPath}@${size}`;
        return new Promise((resolve) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const req = tx.objectStore(this.STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result ? req.result.dataURL : null);
            req.onerror = () => resolve(null);
        });
    },

    async put(modelPath, size, dataURL) {
        const db = await this.open();
        if (!db) return;
        const key = `${modelPath}@${size}`;
        const tx = db.transaction(this.STORE_NAME, 'readwrite');
        tx.objectStore(this.STORE_NAME).put({ key, modelPath, size, dataURL, ts: Date.now() });
    },

    async clear() {
        const db = await this.open();
        if (!db) return;
        const tx = db.transaction(this.STORE_NAME, 'readwrite');
        tx.objectStore(this.STORE_NAME).clear();
        console.log('[thumb-cache] cleared');
    }
};

let studsInitialized = false;

function renderModelToDataURL(modelPath, size, callback) {
    if (!studsInitialized) {
        LDR.Studs.makeGenerators('', 0, 1);
        studsInitialized = true;
    }

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(size, size);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000000);

    const scene = new THREE.Scene();
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    scene.background = new THREE.Color(isDark ? 0x2a2a2a : 0xf0f0f0);

    const baseObject = new THREE.Group();
    const opaqueObject = new THREE.Group();
    const sixteenObject = new THREE.Group();
    const transObject = new THREE.Group();
    baseObject.add(opaqueObject);
    baseObject.add(sixteenObject);
    baseObject.add(transObject);
    scene.add(baseObject);

    const mc = new LDR.MeshCollector(opaqueObject, sixteenObject, transObject);

    const onLoad = function () {
        try {
            ldrLoader.generate(14, mc);
        } catch (e) {
            callback(null, 'render error');
            renderer.dispose();
            return;
        }

        const b = mc.boundingBox;
        const center = new THREE.Vector3();
        b.getCenter(center);
        baseObject.position.set(-center.x, -center.y, -center.z);

        const modelSize = b.min.distanceTo(b.max);
        camera.position.set(modelSize, 0.7 * modelSize, modelSize);
        camera.lookAt(new THREE.Vector3());
        camera.far = 2 * modelSize;
        camera.left = -size;
        camera.right = size;
        camera.top = size;
        camera.bottom = -size;
        camera.zoom = 1.4 * size / modelSize;
        camera.updateProjectionMatrix();

        renderer.render(scene, camera);

        const dataURL = canvas.toDataURL('image/png');
        callback(dataURL, null);

        renderer.dispose();
        renderer.forceContextLoss();
    };

    const onError = function () {
        callback(null, 'missing parts');
        renderer.dispose();
        renderer.forceContextLoss();
    };

    const ldrLoader = new THREE.LDRLoader(onLoad, null, { cleanUpPrimitivesAndSubParts: false, onError: onError });
    ldrLoader.load(modelPath);
}

function makeErrorDataURL(size, message) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    ctx.fillStyle = isDark ? '#3a1a1a' : '#fee';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = isDark ? '#e08080' : '#c00';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(message || 'error', size / 2, size / 2);
    return c.toDataURL('image/png');
}

/**
 * Render thumbnails sequentially into <img> elements.
 * Checks IndexedDB cache first; only renders on cache miss.
 */
function renderAllThumbnails(imgSelector, size) {
    size = size || 200;
    const imgs = Array.from(document.querySelectorAll(imgSelector));
    let idx = 0;
    let cacheHits = 0;
    let rendered = 0;

    function next() {
        if (idx >= imgs.length) {
            console.log(`[thumbnails] done: ${cacheHits} cached, ${rendered} rendered, ${imgs.length} total`);
            return;
        }
        const img = imgs[idx++];
        const model = img.dataset.model;
        if (!model) { next(); return; }

        // BJB> Check cache first
        ThumbCache.get(model, size).then(cached => {
            if (cached) {
                img.src = cached;
                cacheHits++;
                next(); // no delay needed for cache hits
            } else {
                renderModelToDataURL(model, size, (dataURL, error) => {
                    if (dataURL) {
                        img.src = dataURL;
                        ThumbCache.put(model, size, dataURL);
                        rendered++;
                    } else {
                        const errorURL = makeErrorDataURL(size, error);
                        img.src = errorURL;
                        // BJB> Don't cache errors -- parts might be added later
                    }
                    setTimeout(next, 30);
                });
            }
        });
    }

    next();
}

// BJB> Expose cache clear for dev console: ThumbCache.clear()
window.ThumbCache = ThumbCache;
