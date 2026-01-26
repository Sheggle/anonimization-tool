import './styles.css';
import { PATTERNS, isPattern } from './patterns.js';
import mupdfModule from './mupdf-loader.js';
import { createOfflineWorker } from './tesseract-loader.js';

// MuPDF module
let mupdf = mupdfModule;
let mupdfReady = true;

// Tesseract for OCR (using bundled offline loader)
let tesseractWorker = null;

// State
let pdfDocument = null;
let pdfData = null;
let matches = [];
let pageImages = [];

// Drawing state for manual redaction boxes
let isDrawing = false;
let drawStartX = 0;
let drawStartY = 0;
let currentDrawingPage = null;
let drawPreviewElement = null;

// OCR cache: Map<pageNum, blocks[]>
// Cleared when new document is loaded
const ocrCache = new Map();

// Worker pool for parallel OCR
const WORKER_POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 4);
let workerPool = [];
let workerPoolReady = false;

// DOM Elements
const fileInput = document.getElementById('fileInput');
const uploadZone = document.getElementById('uploadZone');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const pageCount = document.getElementById('pageCount');
const termsInput = document.getElementById('termsInput');
const scanBtn = document.getElementById('scanBtn');
const processBtn = document.getElementById('processBtn');
const ocrCheckbox = document.getElementById('ocrCheckbox');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const previewScroll = document.getElementById('previewScroll');
const matchList = document.getElementById('matchList');
const matchItems = document.getElementById('matchItems');
const matchCount = document.getElementById('matchCount');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusEl = document.getElementById('status');

// Coordinate transformation: display coordinates → PDF coordinates
function displayToPdfCoords(displayX, displayY, pageNum, container) {
    const canvas = container.querySelector('canvas');
    const pageInfo = pageImages[pageNum];
    if (!pageInfo || !canvas) return null;

    const displayScale = canvas.offsetWidth / canvas.width;

    // Display → Canvas → PDF
    const canvasX = displayX / displayScale;
    const canvasY = displayY / displayScale;
    return {
        x: canvasX / pageInfo.scale,
        y: canvasY / pageInfo.scale
    };
}

// Status helpers
function showStatus(message, type = 'loading') {
    statusEl.className = `status visible ${type}`;
    statusEl.innerHTML = type === 'loading'
        ? `<span class="spinner"></span>${message}`
        : message;
}

function hideStatus() {
    statusEl.className = 'status';
}

function showProgress(percent, text) {
    progressContainer.classList.remove('hidden');
    progressFill.style.width = `${percent}%`;
    progressText.textContent = text;
}

function hideProgress() {
    progressContainer.classList.add('hidden');
}

// File upload handlers
uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
        handleFile(e.target.files[0]);
    }
});

async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        showStatus('Please select a PDF file', 'error');
        return;
    }

    if (!mupdfReady) {
        showStatus('MuPDF library is still loading. Please wait...', 'loading');
        return;
    }

    // Clear OCR cache for new document
    ocrCache.clear();

    showStatus('Loading PDF...');

    try {
        pdfData = new Uint8Array(await file.arrayBuffer());
        pdfDocument = mupdf.Document.openDocument(pdfData, "application/pdf");

        const numPages = pdfDocument.countPages();

        fileName.textContent = file.name;
        pageCount.textContent = `${numPages} page${numPages !== 1 ? 's' : ''}`;
        fileInfo.classList.add('visible');

        scanBtn.disabled = false;
        hideStatus();

        // Clear previous matches
        matches = [];
        matchList.classList.add('hidden');
        processBtn.disabled = true;

        // Generate previews
        await generatePreviews();

    } catch (err) {
        console.error(err);
        showStatus(`Error loading PDF: ${err.message}`, 'error');
    }
}

// Convert pixmap to canvas ImageData
function pixmapToImageData(pixmap) {
    const w = pixmap.getWidth();
    const h = pixmap.getHeight();
    const pixels = pixmap.getPixels();
    const n = pixmap.getNumberOfComponents();

    // Create RGBA image data
    const rgba = new Uint8ClampedArray(w * h * 4);

    if (n === 4) {
        // Already RGBA
        rgba.set(pixels);
    } else if (n === 3) {
        // RGB -> RGBA
        for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
            rgba[j] = pixels[i];
            rgba[j + 1] = pixels[i + 1];
            rgba[j + 2] = pixels[i + 2];
            rgba[j + 3] = 255;
        }
    } else if (n === 1) {
        // Grayscale -> RGBA
        for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
            rgba[j] = rgba[j + 1] = rgba[j + 2] = pixels[i];
            rgba[j + 3] = 255;
        }
    }

    return new ImageData(rgba, w, h);
}

async function generatePreviews() {
    if (!pdfDocument) return;

    previewPlaceholder.classList.add('hidden');
    previewScroll.classList.remove('hidden');
    previewScroll.innerHTML = '';
    pageImages = [];

    const numPages = pdfDocument.countPages();

    for (let i = 0; i < numPages; i++) {
        const page = pdfDocument.loadPage(i);
        const bounds = page.getBounds();
        const width = bounds[2] - bounds[0];
        const height = bounds[3] - bounds[1];

        // Render at reasonable scale for preview
        const scale = Math.min(800 / width, 1.5);
        const pixmap = page.toPixmap(
            mupdf.Matrix.scale(scale, scale),
            mupdf.ColorSpace.DeviceRGB,
            false,
            true
        );

        const imageData = pixmapToImageData(pixmap);
        pageImages.push({ width, height, scale, bounds });

        const container = document.createElement('div');
        container.className = 'page-preview';
        container.id = `page-${i}`;

        const canvas = document.createElement('canvas');
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);

        const label = document.createElement('div');
        label.className = 'page-label';
        label.textContent = `Page ${i + 1}`;

        container.appendChild(canvas);
        container.appendChild(label);
        previewScroll.appendChild(container);

        // Attach drawing handlers for manual redaction
        attachDrawingHandlers(container, i);
    }
}

// Term input handler
termsInput.addEventListener('input', () => {
    scanBtn.disabled = !pdfDocument || !termsInput.value.trim();
});

// Extract text blocks with bounding boxes from structured text
function extractTextBlocks(structuredText) {
    const blocks = [];

    try {
        const textJson = JSON.parse(structuredText.asJSON());

        for (const block of textJson.blocks || []) {
            for (const line of block.lines || []) {
                // In newer mupdf, text is directly on line.text
                const lineText = line.text || '';

                // bbox can be an object {x, y, w, h} or array [x0, y0, x1, y1]
                let bbox = line.bbox;
                if (bbox && typeof bbox === 'object' && 'x' in bbox) {
                    // Convert {x, y, w, h} to [x0, y0, x1, y1]
                    bbox = [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h];
                }

                if (lineText && bbox) {
                    blocks.push({
                        text: lineText,
                        bbox: bbox,
                        type: 'line'
                    });
                }
            }
        }
    } catch (err) {
        console.error('Error parsing structured text:', err);
    }

    return blocks;
}

// Find matches using regex on extracted text, get precise bbox from MuPDF
function findMatchesOnPage(page, term, pageNum) {
    const results = [];
    const structuredText = page.toStructuredText("preserve-whitespace");
    const blocks = extractTextBlocks(structuredText);

    // Determine regex and validator
    let regex, validate;
    if (isPattern(term)) {
        const pattern = PATTERNS[term];
        regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        validate = pattern.validate;
    } else {
        // Treat term as regex (case-insensitive)
        try {
            regex = new RegExp(term, 'gi');
        } catch (e) {
            // Invalid regex - escape and use as literal
            regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        }
        validate = () => true;
    }

    // Collect all regex matches with estimated positions
    const regexMatches = [];
    for (const block of blocks) {
        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(block.text)) !== null) {
            const matchedText = match[0];
            if (!validate(matchedText)) continue;

            // Estimate position for correlation
            const estBbox = estimateBbox(block, match.index, matchedText.length);
            regexMatches.push({
                text: matchedText,
                term,
                estBbox,
                blockBbox: block.bbox,
                pageNum
            });
        }
    }

    // Get all MuPDF quads for each unique matched text
    const textToQuads = new Map();
    for (const m of regexMatches) {
        if (!textToQuads.has(m.text)) {
            const quads = page.search(m.text);
            const bboxes = [];
            if (quads) {
                for (const quadWrapper of quads) {
                    const quad = quadWrapper[0];
                    if (quad) {
                        bboxes.push(quadToBbox(quad));
                    }
                }
            }
            textToQuads.set(m.text, bboxes);
        }
    }

    // Match each regex result with the closest MuPDF bbox
    const usedBboxes = new Set();
    for (const m of regexMatches) {
        const bboxes = textToQuads.get(m.text) || [];

        // Find bbox that overlaps with the block's y-range and is closest to estimated x
        let bestBbox = null;
        let bestDist = Infinity;

        for (const bbox of bboxes) {
            const key = bbox.join(',');
            if (usedBboxes.has(key)) continue;

            // Check y overlap (same line)
            const yOverlap = bbox[1] < m.blockBbox[3] && bbox[3] > m.blockBbox[1];
            if (!yOverlap) continue;

            // Distance from estimated x position
            const dist = Math.abs(bbox[0] - m.estBbox[0]);
            if (dist < bestDist) {
                bestDist = dist;
                bestBbox = bbox;
            }
        }

        if (bestBbox) {
            usedBboxes.add(bestBbox.join(','));
            results.push({
                text: m.text,
                term: m.term,
                bbox: bestBbox,
                pageNum
            });
        } else {
            // Fallback to estimated bbox if no MuPDF match
            results.push({
                text: m.text,
                term: m.term,
                bbox: m.estBbox,
                pageNum
            });
        }
    }

    return results;
}

// Estimate bounding box for a substring within a text block
function estimateBbox(block, charIndex, charLength) {
    const text = block.text;
    const bbox = block.bbox; // [x0, y0, x1, y1]

    if (!text || text.length === 0) return bbox;

    const lineWidth = bbox[2] - bbox[0];
    const charWidth = lineWidth / text.length;

    const x0 = bbox[0] + charIndex * charWidth;
    const x1 = bbox[0] + (charIndex + charLength) * charWidth;

    return [x0, bbox[1], x1, bbox[3]];
}

// Convert MuPDF quad to bbox [x0, y0, x1, y1]
function quadToBbox(quad) {
    // Quad is [x0,y0, x1,y1, x2,y2, x3,y3] (4 corners)
    // We need the bounding rectangle
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys)
    ];
}

// Initialize Tesseract for OCR (using bundled offline resources)
async function initTesseract() {
    if (tesseractWorker) return;

    showStatus('Loading OCR engine (Tesseract.js)...', 'loading');

    try {
        // Create worker with bundled Dutch + English language data
        tesseractWorker = await createOfflineWorker({
            logger: (m) => {
                if (m.status === 'recognizing text') {
                    showProgress(m.progress * 100, `OCR: ${Math.round(m.progress * 100)}%`);
                } else if (m.status) {
                    showStatus(`OCR: ${m.status}...`, 'loading');
                }
            }
        });

        showStatus('OCR engine ready', 'success');
    } catch (err) {
        console.error('Failed to load Tesseract:', err);
        showStatus(`Failed to load OCR: ${err.message}`, 'error');
        throw err;
    }
}

// Initialize worker pool for parallel OCR
async function initWorkerPool() {
    if (workerPoolReady) return;

    showStatus(`Initializing ${WORKER_POOL_SIZE} OCR workers...`, 'loading');

    try {
        workerPool = await Promise.all(
            Array(WORKER_POOL_SIZE).fill().map(() =>
                createOfflineWorker({ logger: () => {} })
            )
        );
        workerPoolReady = true;
        showStatus('OCR workers ready', 'success');
    } catch (err) {
        console.error('Failed to initialize worker pool:', err);
        showStatus(`Failed to initialize OCR workers: ${err.message}`, 'error');
        throw err;
    }
}

// Perform OCR on a page (with caching)
async function ocrPage(pageNum) {
    // Check cache first
    if (ocrCache.has(pageNum)) {
        return ocrCache.get(pageNum);
    }

    if (!tesseractWorker) {
        await initTesseract();
    }

    const page = pdfDocument.loadPage(pageNum);
    const bounds = page.getBounds();

    // Render at high resolution for OCR
    const scale = Math.max(300 / 72, 2); // At least 300 DPI
    const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
    );

    const imageData = pixmapToImageData(pixmap);

    // Create canvas for Tesseract
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);

    // Run OCR
    const result = await tesseractWorker.recognize(canvas);

    // Convert Tesseract results to our block format
    const blocks = [];
    for (const word of result.data.words) {
        // Convert pixel coordinates back to PDF coordinates
        const bbox = [
            word.bbox.x0 / scale,
            word.bbox.y0 / scale,
            word.bbox.x1 / scale,
            word.bbox.y1 / scale
        ];

        blocks.push({
            text: word.text,
            bbox,
            type: 'ocr',
            confidence: word.confidence
        });
    }

    // Cache result before returning
    ocrCache.set(pageNum, blocks);
    return blocks;
}

// Perform OCR on a page using a specific worker (for parallel processing)
async function ocrPageWithWorker(pageNum, worker) {
    // Check cache first
    if (ocrCache.has(pageNum)) {
        return { pageNum, blocks: ocrCache.get(pageNum) };
    }

    const page = pdfDocument.loadPage(pageNum);

    // Render at high resolution for OCR
    const scale = Math.max(300 / 72, 2); // At least 300 DPI
    const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
    );

    const imageData = pixmapToImageData(pixmap);

    // Create canvas for Tesseract
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);

    // Run OCR with specific worker
    const result = await worker.recognize(canvas);

    // Convert Tesseract results to our block format
    const blocks = [];
    for (const word of result.data.words) {
        // Convert pixel coordinates back to PDF coordinates
        const bbox = [
            word.bbox.x0 / scale,
            word.bbox.y0 / scale,
            word.bbox.x1 / scale,
            word.bbox.y1 / scale
        ];

        blocks.push({
            text: word.text,
            bbox,
            type: 'ocr',
            confidence: word.confidence
        });
    }

    // Cache result
    ocrCache.set(pageNum, blocks);
    return { pageNum, blocks };
}

// Process multiple pages in parallel using worker pool
async function ocrPagesParallel(pageNumbers, onProgress) {
    const results = new Map();
    let completed = 0;

    // Process in batches of WORKER_POOL_SIZE
    for (let i = 0; i < pageNumbers.length; i += WORKER_POOL_SIZE) {
        const batch = pageNumbers.slice(i, i + WORKER_POOL_SIZE);

        const batchPromises = batch.map((pageNum, idx) =>
            ocrPageWithWorker(pageNum, workerPool[idx])
        );

        const batchResults = await Promise.all(batchPromises);

        for (const { pageNum, blocks } of batchResults) {
            results.set(pageNum, blocks);
        }

        completed += batch.length;
        onProgress(completed, pageNumbers.length);
    }

    return results;
}

// Scan for matches
scanBtn.addEventListener('click', async () => {
    if (!pdfDocument || !termsInput.value.trim()) return;

    showStatus('Scanning for matches...');
    // Preserve manual redactions when rescanning
    const manualMatches = matches.filter(m => m.isManual);
    matches = [...manualMatches];

    const terms = termsInput.value
        .split('\n')
        .map(t => t.trim())
        .filter(t => t);

    const numPages = pdfDocument.countPages();
    const useOCR = ocrCheckbox.checked;

    // PHASE 1: Identify pages needing OCR
    const pagesToOcr = [];
    if (useOCR) {
        showStatus('Checking pages for text content...');
        for (let pageNum = 0; pageNum < numPages; pageNum++) {
            // Skip if already cached
            if (ocrCache.has(pageNum)) {
                pagesToOcr.push(pageNum); // Still include for searching
                continue;
            }
            const page = pdfDocument.loadPage(pageNum);
            const structuredText = page.toStructuredText("preserve-whitespace");
            const blocks = extractTextBlocks(structuredText);
            const hasText = blocks.some(b => b.text.trim().length > 10);
            if (!hasText) {
                pagesToOcr.push(pageNum);
            }
        }
    }

    // PHASE 2: Parallel OCR (with caching)
    if (pagesToOcr.length > 0) {
        // Filter to only pages not in cache
        const uncachedPages = pagesToOcr.filter(p => !ocrCache.has(p));

        if (uncachedPages.length > 0) {
            try {
                await initWorkerPool();
            } catch (err) {
                return; // Error already shown
            }

            showStatus(`Running OCR on ${uncachedPages.length} scanned pages...`);

            await ocrPagesParallel(uncachedPages, (done, total) => {
                showProgress((done / total) * 50, `OCR: ${done}/${total} pages`);
            });
        }
    }

    // PHASE 3: Search for matches (uses cached OCR results)
    for (let pageNum = 0; pageNum < numPages; pageNum++) {
        showProgress(50 + (pageNum / numPages) * 50, `Searching page ${pageNum + 1} of ${numPages}...`);

        const page = pdfDocument.loadPage(pageNum);

        // If OCR was done for this page, search OCR results
        if (ocrCache.has(pageNum)) {
            const ocrBlocks = ocrCache.get(pageNum);
            for (const term of terms) {
                let regex, validate;
                if (isPattern(term)) {
                    const pattern = PATTERNS[term];
                    regex = new RegExp(pattern.regex.source, pattern.regex.flags);
                    validate = pattern.validate;
                } else {
                    try {
                        regex = new RegExp(term, 'gi');
                    } catch (e) {
                        regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                    }
                    validate = () => true;
                }

                for (const block of ocrBlocks) {
                    regex.lastIndex = 0;
                    let match;
                    while ((match = regex.exec(block.text)) !== null) {
                        if (!validate(match[0])) continue;
                        // Estimate bbox for the match within the OCR block
                        const estBbox = estimateBbox(block, match.index, match[0].length);
                        matches.push({
                            text: match[0],
                            term,
                            bbox: estBbox,
                            pageNum
                        });
                    }
                }
            }
        }

        // Search for matches using MuPDF's precise search (for text-based pages or hybrid)
        for (const term of terms) {
            const termMatches = findMatchesOnPage(page, term, pageNum);
            matches.push(...termMatches);
        }

        // Allow UI to update
        await new Promise(r => setTimeout(r, 0));
    }

    // Update UI with matches
    updateMatchDisplay();
    hideProgress();

    if (matches.length > 0) {
        showStatus(`Found ${matches.length} match${matches.length !== 1 ? 'es' : ''} to redact`, 'success');
        processBtn.disabled = false;
    } else {
        showStatus('No matches found. Try different search terms.', 'error');
        processBtn.disabled = true;
    }
});

function updateMatchDisplay() {
    matchList.classList.remove('hidden');
    matchCount.textContent = matches.length;
    matchItems.innerHTML = '';

    // Group by page
    const byPage = {};
    for (const match of matches) {
        if (!byPage[match.pageNum]) byPage[match.pageNum] = [];
        byPage[match.pageNum].push(match);
    }

    // Display matches
    for (const [pageNum, pageMatches] of Object.entries(byPage)) {
        for (const match of pageMatches.slice(0, 5)) {
            const item = document.createElement('div');
            item.className = 'match-item';
            item.innerHTML = `
                <span class="match-term">"${escapeHtml(match.text.substring(0, 30))}${match.text.length > 30 ? '...' : ''}"</span>
                <span class="match-page">Page ${parseInt(pageNum) + 1}</span>
            `;
            matchItems.appendChild(item);
        }
        if (pageMatches.length > 5) {
            const more = document.createElement('div');
            more.className = 'match-item';
            more.innerHTML = `<span style="color: var(--text-muted)">...and ${pageMatches.length - 5} more on page ${parseInt(pageNum) + 1}</span>`;
            matchItems.appendChild(more);
        }
    }

    // Draw overlays on preview
    drawMatchOverlays();
}

function drawMatchOverlays() {
    // Remove existing overlays
    document.querySelectorAll('.match-overlay').forEach(el => el.remove());

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const pageContainer = document.getElementById(`page-${match.pageNum}`);
        if (!pageContainer) continue;

        const canvas = pageContainer.querySelector('canvas');
        const pageInfo = pageImages[match.pageNum];
        if (!pageInfo) continue;

        const bbox = match.bbox;
        const scale = pageInfo.scale;

        // Convert PDF coordinates to canvas coordinates
        const x = bbox[0] * scale;
        const y = bbox[1] * scale;
        const width = (bbox[2] - bbox[0]) * scale;
        const height = (bbox[3] - bbox[1]) * scale;

        // Scale to displayed size
        const displayScale = canvas.offsetWidth / canvas.width;

        const overlay = document.createElement('div');
        overlay.className = 'match-overlay';
        if (match.isManual) {
            overlay.classList.add('manual-overlay');
        }
        overlay.style.left = `${x * displayScale}px`;
        overlay.style.top = `${y * displayScale}px`;
        overlay.style.width = `${width * displayScale}px`;
        overlay.style.height = `${height * displayScale}px`;

        // Add delete button for manual overlays
        if (match.isManual) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'overlay-delete-btn';
            deleteBtn.innerHTML = '×';
            deleteBtn.title = 'Remove this redaction';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeManualRedaction(i);
            });
            overlay.appendChild(deleteBtn);
        }

        pageContainer.appendChild(overlay);
    }
}

// Manual redaction management
function addManualRedaction(pageNum, bbox) {
    const match = {
        text: '[Manual Redaction]',
        term: '__manual__',
        bbox: bbox,
        pageNum: pageNum,
        isManual: true
    };
    matches.push(match);
    updateMatchDisplay();
    processBtn.disabled = false;
}

function removeManualRedaction(index) {
    if (index >= 0 && index < matches.length) {
        matches.splice(index, 1);
        updateMatchDisplay();
        if (matches.length === 0) {
            processBtn.disabled = true;
        }
    }
}

// Drawing event handlers
function handleDrawStart(e, pageNum, container) {
    // Only start drawing with left mouse button
    if (e.button !== 0) return;

    // Don't start drawing if clicking on an overlay or delete button
    if (e.target.classList.contains('match-overlay') ||
        e.target.classList.contains('overlay-delete-btn') ||
        e.target.closest('.manual-overlay')) {
        return;
    }

    const canvas = container.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();

    isDrawing = true;
    currentDrawingPage = pageNum;
    drawStartX = e.clientX - rect.left;
    drawStartY = e.clientY - rect.top;

    // Create preview element
    drawPreviewElement = document.createElement('div');
    drawPreviewElement.className = 'draw-preview';
    drawPreviewElement.style.left = `${drawStartX}px`;
    drawPreviewElement.style.top = `${drawStartY}px`;
    drawPreviewElement.style.width = '0px';
    drawPreviewElement.style.height = '0px';
    container.appendChild(drawPreviewElement);

    e.preventDefault();
}

function handleDrawMove(e, container) {
    if (!isDrawing || !drawPreviewElement) return;

    const canvas = container.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();

    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    // Calculate dimensions (handle negative drag)
    const left = Math.min(drawStartX, currentX);
    const top = Math.min(drawStartY, currentY);
    const width = Math.abs(currentX - drawStartX);
    const height = Math.abs(currentY - drawStartY);

    drawPreviewElement.style.left = `${left}px`;
    drawPreviewElement.style.top = `${top}px`;
    drawPreviewElement.style.width = `${width}px`;
    drawPreviewElement.style.height = `${height}px`;
}

function handleDrawEnd(e, pageNum, container) {
    if (!isDrawing) return;

    const canvas = container.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();

    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;

    // Calculate final dimensions
    const left = Math.min(drawStartX, endX);
    const top = Math.min(drawStartY, endY);
    const width = Math.abs(endX - drawStartX);
    const height = Math.abs(endY - drawStartY);

    // Remove preview element
    if (drawPreviewElement) {
        drawPreviewElement.remove();
        drawPreviewElement = null;
    }

    // Only create redaction if box is at least 5px in both dimensions
    if (width >= 5 && height >= 5) {
        // Convert display coordinates to PDF coordinates
        const topLeft = displayToPdfCoords(left, top, pageNum, container);
        const bottomRight = displayToPdfCoords(left + width, top + height, pageNum, container);

        if (topLeft && bottomRight) {
            // Create normalized bbox [x0, y0, x1, y1]
            const bbox = [
                Math.min(topLeft.x, bottomRight.x),
                Math.min(topLeft.y, bottomRight.y),
                Math.max(topLeft.x, bottomRight.x),
                Math.max(topLeft.y, bottomRight.y)
            ];
            addManualRedaction(pageNum, bbox);
        }
    }

    // Reset drawing state
    isDrawing = false;
    currentDrawingPage = null;
}

function handleDrawCancel() {
    if (drawPreviewElement) {
        drawPreviewElement.remove();
        drawPreviewElement = null;
    }
    isDrawing = false;
    currentDrawingPage = null;
}

// Attach drawing handlers to a page container
function attachDrawingHandlers(container, pageNum) {
    container.addEventListener('mousedown', (e) => handleDrawStart(e, pageNum, container));
    container.addEventListener('mousemove', (e) => handleDrawMove(e, container));
    container.addEventListener('mouseup', (e) => handleDrawEnd(e, pageNum, container));
    container.addEventListener('mouseleave', handleDrawCancel);
}

// Process and download
processBtn.addEventListener('click', async () => {
    if (!pdfDocument || matches.length === 0) return;

    showStatus('Applying redactions...');
    processBtn.disabled = true;
    scanBtn.disabled = true;

    try {
        // Reload document fresh for modifications
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");
        const numPages = doc.countPages();

        // Group matches by page
        const matchesByPage = {};
        for (const match of matches) {
            if (!matchesByPage[match.pageNum]) matchesByPage[match.pageNum] = [];
            matchesByPage[match.pageNum].push(match);
        }

        // Create output buffer and writer
        const buffer = new mupdf.Buffer();
        const writer = new mupdf.DocumentWriter(buffer, "pdf", "");

        // Process each page with hybrid approach:
        // 1. Apply redactions to remove text layer
        // 2. Render the page (now with text removed)
        // 3. Draw black rectangles on top (for visual redaction of images)
        for (let pageNum = 0; pageNum < numPages; pageNum++) {
            showProgress((pageNum / numPages) * 100, `Redacting page ${pageNum + 1} of ${numPages}...`);

            const page = doc.loadPage(pageNum);
            const bounds = page.getBounds();
            const pageMatches = matchesByPage[pageNum] || [];

            if (pageMatches.length > 0) {
                // Rasterize the page and burn black rectangles directly into pixels.
                // This avoids applyRedactions() and page.run()-to-PDF-writer, both
                // of which can fail on JBIG2-encoded images. The toPixmap() rendering
                // path handles JBIG2 fine. The output is a flat raster image — no text
                // layer, no original image streams — redacted content is destroyed.
                const width = bounds[2] - bounds[0];
                const height = bounds[3] - bounds[1];
                const scale = Math.min(3, 4000 / Math.max(width, height));
                const pixmap = page.toPixmap(
                    mupdf.Matrix.scale(scale, scale),
                    mupdf.ColorSpace.DeviceRGB,
                    false,
                    true
                );
                const pixels = pixmap.getPixels();
                const stride = pixmap.getStride();
                const n = pixmap.getNumberOfComponents();

                for (const match of pageMatches) {
                    const x0 = Math.floor((match.bbox[0] - bounds[0]) * scale);
                    const y0 = Math.floor((match.bbox[1] - bounds[1]) * scale);
                    const x1 = Math.ceil((match.bbox[2] - bounds[0]) * scale);
                    const y1 = Math.ceil((match.bbox[3] - bounds[1]) * scale);
                    for (let y = Math.max(0, y0); y < Math.min(pixmap.getHeight(), y1); y++) {
                        for (let x = Math.max(0, x0); x < Math.min(pixmap.getWidth(), x1); x++) {
                            const idx = y * stride + x * n;
                            for (let c = 0; c < n; c++) pixels[idx + c] = 0;
                        }
                    }
                }

                const image = new mupdf.Image(pixmap);
                const device = writer.beginPage(bounds);
                const imgMatrix = [
                    bounds[2] - bounds[0], 0,
                    0, bounds[3] - bounds[1],
                    bounds[0], bounds[1]
                ];
                device.fillImage(image, imgMatrix, 1);
                writer.endPage();
                image.destroy();
                pixmap.destroy();
            } else {
                // No matches — pass through unchanged via page.run().
                const device = writer.beginPage(bounds);
                try {
                    page.run(device, mupdf.Matrix.identity);
                } catch (e) {
                    console.warn(`page.run failed on page ${pageNum + 1}, rasterizing: ${e.message}`);
                    const w = bounds[2] - bounds[0];
                    const h = bounds[3] - bounds[1];
                    const s = Math.min(3, 4000 / Math.max(w, h));
                    const pixmap = page.toPixmap(
                        mupdf.Matrix.scale(s, s),
                        mupdf.ColorSpace.DeviceRGB,
                        false,
                        true
                    );
                    const image = new mupdf.Image(pixmap);
                    const imgMatrix = [
                        bounds[2] - bounds[0], 0,
                        0, bounds[3] - bounds[1],
                        bounds[0], bounds[1]
                    ];
                    device.fillImage(image, imgMatrix, 1);
                    image.destroy();
                    pixmap.destroy();
                }
                writer.endPage();
            }
            page.destroy();

            await new Promise(r => setTimeout(r, 0));
        }

        writer.close();
        showProgress(90, 'Saving PDF...');

        // Get the output data
        const outputData = buffer.asUint8Array();

        // Download
        const blob = new Blob([outputData], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName.textContent.replace('.pdf', '_anonymized.pdf');
        a.click();
        URL.revokeObjectURL(url);

        hideProgress();
        showStatus('PDF anonymized and downloaded successfully!', 'success');

    } catch (err) {
        console.error(err);
        showStatus(`Error during redaction: ${err.message}`, 'error');
    } finally {
        processBtn.disabled = false;
        scanBtn.disabled = false;
    }
});

// Utility
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Handle window resize for overlay positions
window.addEventListener('resize', () => {
    if (matches.length > 0) {
        drawMatchOverlays();
    }
});

// Initialize - MuPDF is already loaded via static import
console.log('PDF Anonymizer loaded. MuPDF ready.');
hideStatus();
