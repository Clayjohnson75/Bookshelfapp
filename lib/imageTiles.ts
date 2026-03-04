import sharp from 'sharp';

export interface TileOptions {
 rows?: number;
 cols?: number;
 overlapPct?: number;
 /** Fixed tile width in px (shelf mode). Use with stepX for 50% overlap. */
 tileWidth?: number;
 /** Step between tile starts in px (shelf mode). stepX = tileWidth/2 50% overlap. */
 stepX?: number;
 /** Max length of longest side (default 1200). Use 2000+ and higher webpQuality for sharper tiles when spine text is tiny. */
 maxLongestSide?: number;
 /** WebP quality 01 (default 0.6). Use ~0.85 for tiles to avoid over-compression killing spine text. */
 webpQuality?: number;
}

export interface TileResult {
 buffer: Buffer;
 mimeType: 'image/webp' | 'image/jpeg';
 tileIndex: number;
 region: { left: number; top: number; width: number; height: number };
}

/**
 * Split image into overlapping tiles. For shelf spine scanning, use vertical strips
 * with 2535% overlap. Wider tiles (600800px) reduce boundary splits and improve recall.
 * Example: tileWidth=800, stepX=560 240px overlap (~30%).
 */
export async function splitImageIntoTiles(
 imageBuffer: Buffer,
 opts: TileOptions = {}
): Promise<TileResult[]> {
 const { rows = 1, cols = 8, overlapPct = 0.17, tileWidth, stepX, maxLongestSide = 1200, webpQuality = 0.6 } = opts;

 const meta = await sharp(imageBuffer).metadata();
 const w = meta.width ?? 0;
 const h = meta.height ?? 0;
 if (!w || !h) throw new Error('Could not read image dimensions');

 const useFixedGeometry = typeof tileWidth === 'number' && typeof stepX === 'number' && stepX > 0;
 const tw = tileWidth ?? 800;
 const sx = stepX ?? 560;

 let tileW: number;
 let tileH: number;
 let overlapX: number;
 let overlapY: number;
 let colCount: number;

 if (useFixedGeometry) {
 tileW = Math.min(tw, w);
 tileH = h;
 overlapX = tileW - sx;
 overlapY = 0;
 colCount = Math.ceil((w - tileW) / sx) + 1;
 } else {
 overlapX = Math.round(w * overlapPct);
 overlapY = Math.round(h * overlapPct);
 tileW = Math.ceil((w + overlapX * (cols - 1)) / cols);
 tileH = Math.ceil((h + overlapY * (rows - 1)) / rows);
 colCount = cols;
 }

 const tiles: TileResult[] = [];
 let tileIndex = 0;
 const DEBUG_TILES = process.env.DEBUG_TILES === 'true';

 for (let row = 0; row < rows; row++) {
 for (let col = 0; col < colCount; col++) {
 const left = useFixedGeometry
 ? Math.min(col * sx, Math.max(0, w - tileW))
 : Math.min(col * (tileW - overlapX), w - 1);
 const top = useFixedGeometry ? 0 : Math.min(row * (tileH - overlapY), h - 1);
 const width = Math.min(tileW, w - left);
 const height = useFixedGeometry ? h : Math.min(tileH, h - top);

 let pipeline = sharp(imageBuffer)
 .extract({ left: Math.max(0, left), top: Math.max(0, top), width, height });

 const longest = Math.max(width, height);
 if (longest > maxLongestSide) {
 pipeline = pipeline.resize(maxLongestSide, maxLongestSide, { fit: 'inside', withoutEnlargement: true });
 }

 const buf = await pipeline
 .webp({ quality: Math.round(webpQuality * 100), effort: 4 })
 .toBuffer();

 const region = { left, top, width, height };
 tiles.push({ buffer: buf, mimeType: 'image/webp', tileIndex, region });

 if (DEBUG_TILES) {
 try {
 const { tmpdir } = await import('os');
 const { writeFile } = await import('fs').then(m => m.promises);
 const path = `${tmpdir()}/tile_${tileIndex}_${left}_${top}.webp`;
 await writeFile(path, buf);
 console.log(`[TILES] saved preview: ${path} (${buf.length} bytes)`);
 } catch {
 // Ignore - tmp may not be writable in serverless
 }
 }
 tileIndex++;
 }
 }

 return tiles;
}

export interface HorizontalBandOptions {
 /** Number of bands (2 or 3). Default 3: top, middle, bottom. */
 bands?: number;
 /** Overlap between bands as fraction of band height (0.10.2). Default 0.15. */
 overlapPct?: number;
 maxLongestSide?: number;
 webpQuality?: number;
}

/**
 * Split image into 23 overlapping horizontal bands (full width). Use in addition to vertical strips
 * to catch stacked horizontal books, titles near top/bottom, and glare/blur zones.
 */
export async function splitImageIntoHorizontalBands(
 imageBuffer: Buffer,
 opts: HorizontalBandOptions = {}
): Promise<TileResult[]> {
 const { bands = 3, overlapPct = 0.15, maxLongestSide = 1200, webpQuality = 0.6 } = opts;

 const meta = await sharp(imageBuffer).metadata();
 const w = meta.width ?? 0;
 const h = meta.height ?? 0;
 if (!w || !h) throw new Error('Could not read image dimensions');

 const n = Math.max(2, Math.min(3, bands));
 const overlapY = Math.round(h * overlapPct);
 const bandHeight = Math.ceil((h + overlapY * (n - 1)) / n);
 const stepY = bandHeight - overlapY;

 const tiles: TileResult[] = [];
 const DEBUG_TILES = process.env.DEBUG_TILES === 'true';

 for (let i = 0; i < n; i++) {
 const top = Math.min(i * stepY, Math.max(0, h - bandHeight));
 const height = Math.min(bandHeight, h - top);
 const left = 0;
 const width = w;

 let pipeline = sharp(imageBuffer)
 .extract({ left, top, width, height });

 const longest = Math.max(width, height);
 if (longest > maxLongestSide) {
 pipeline = pipeline.resize(maxLongestSide, maxLongestSide, { fit: 'inside', withoutEnlargement: true });
 }

 const buf = await pipeline
 .webp({ quality: Math.round(webpQuality * 100), effort: 4 })
 .toBuffer();

 const region = { left, top, width, height };
 tiles.push({ buffer: buf, mimeType: 'image/webp', tileIndex: i, region });

 if (DEBUG_TILES) {
 try {
 const { tmpdir } = await import('os');
 const { writeFile } = await import('fs').then(m => m.promises);
 const path = `${tmpdir()}/band_${i}_${left}_${top}.webp`;
 await writeFile(path, buf);
 console.log(`[TILES] saved band preview: ${path} (${buf.length} bytes)`);
 } catch {
 // Ignore
 }
 }
 }

 return tiles;
}
