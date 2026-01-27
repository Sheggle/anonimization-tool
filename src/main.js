import './styles.css';
import { PATTERNS, isPattern } from './patterns.js';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { jsPDF } from 'jspdf';
import { createOfflineWorker } from './tesseract-loader.js';

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

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

    // Clear OCR cache for new document
    ocrCache.clear();

    showStatus('Loading PDF...');

    try {
        pdfData = new Uint8Array(await file.arrayBuffer());
        pdfDocument = await pdfjsLib.getDocument({ data: pdfData.slice() }).promise;

        const numPages = pdfDocument.numPages;

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

async function generatePreviews() {
    if (!pdfDocument) return;

    previewPlaceholder.classList.add('hidden');
    previewScroll.classList.remove('hidden');
    previewScroll.innerHTML = '';
    pageImages = [];

    const numPages = pdfDocument.numPages;

    for (let i = 0; i < numPages; i++) {
        const page = await pdfDocument.getPage(i + 1); // PDF.js is 1-indexed
        const baseViewport = page.getViewport({ scale: 1 });
        const width = baseViewport.width;
        const height = baseViewport.height;

        // Render at reasonable scale for preview
        const scale = Math.min(800 / width, 1.5);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        pageImages.push({
            width,
            height,
            scale,
            bounds: [0, 0, width, height]
        });

        const container = document.createElement('div');
        container.className = 'page-preview';
        container.id = `page-${i}`;

        const label = document.createElement('div');
        label.className = 'page-label';
        label.textContent = `Page ${i + 1}`;

        container.appendChild(canvas);
        container.appendChild(label);
        previewScroll.appendChild(container);

        // Attach drawing handlers for manual redaction
        attachDrawingHandlers(container, i);

        // Yield to let the browser paint each page progressively
        await new Promise(r => setTimeout(r, 0));
    }
}

// Term input handler
termsInput.addEventListener('input', () => {
    scanBtn.disabled = !pdfDocument || !termsInput.value.trim();
});

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

// Perform OCR on a page using a specific worker (for parallel processing)
async function ocrPageWithWorker(pageNum, worker) {
    // Check cache first
    if (ocrCache.has(pageNum)) {
        return { pageNum, blocks: ocrCache.get(pageNum) };
    }

    const page = await pdfDocument.getPage(pageNum + 1); // PDF.js is 1-indexed

    // Render at high resolution for OCR
    const scale = Math.max(300 / 72, 2); // At least 300 DPI
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Run OCR with specific worker
    const result = await worker.recognize(canvas);

    // Return LINE-level blocks (not words) so multi-word terms match
    const blocks = [];
    for (const line of result.data.lines) {
        blocks.push({
            text: line.text,
            bbox: [
                line.bbox.x0 / scale,
                line.bbox.y0 / scale,
                line.bbox.x1 / scale,
                line.bbox.y1 / scale
            ],
            type: 'ocr',
            confidence: line.confidence
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

    const numPages = pdfDocument.numPages;

    // PHASE 1: OCR all pages (with caching)
    const allPages = [];
    for (let i = 0; i < numPages; i++) {
        allPages.push(i);
    }

    const uncachedPages = allPages.filter(p => !ocrCache.has(p));

    if (uncachedPages.length > 0) {
        try {
            await initWorkerPool();
        } catch (err) {
            return; // Error already shown
        }

        showStatus(`Running OCR on ${uncachedPages.length} pages...`);

        await ocrPagesParallel(uncachedPages, (done, total) => {
            showProgress((done / total) * 50, `OCR: ${done}/${total} pages`);
        });
    }

    // PHASE 2: Search OCR results for matches
    for (let pageNum = 0; pageNum < numPages; pageNum++) {
        showProgress(50 + (pageNum / numPages) * 50, `Searching page ${pageNum + 1} of ${numPages}...`);

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

// Create and append a single overlay div for a match at the given index
function createOverlayForMatch(match, index) {
    const pageContainer = document.getElementById(`page-${match.pageNum}`);
    if (!pageContainer) return;

    const canvas = pageContainer.querySelector('canvas');
    const pageInfo = pageImages[match.pageNum];
    if (!pageInfo) return;

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
            removeManualRedaction(index);
        });
        overlay.appendChild(deleteBtn);
    }

    pageContainer.appendChild(overlay);
}

function drawMatchOverlays() {
    // Remove existing overlays
    document.querySelectorAll('.match-overlay').forEach(el => el.remove());

    for (let i = 0; i < matches.length; i++) {
        createOverlayForMatch(matches[i], i);
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

    // Incrementally append just the new overlay instead of rebuilding all overlays
    createOverlayForMatch(match, matches.length - 1);

    // Update the match list text (but skip the full drawMatchOverlays rebuild)
    matchList.classList.remove('hidden');
    matchCount.textContent = matches.length;

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
        // Reload document fresh for rendering
        const pdf = await pdfjsLib.getDocument({ data: pdfData.slice() }).promise;
        const numPages = pdf.numPages;

        // Group matches by page
        const matchesByPage = {};
        for (const match of matches) {
            if (!matchesByPage[match.pageNum]) matchesByPage[match.pageNum] = [];
            matchesByPage[match.pageNum].push(match);
        }

        // Get first page dimensions to initialize jsPDF
        const firstPage = await pdf.getPage(1);
        const fp = firstPage.getViewport({ scale: 1 });
        const doc = new jsPDF({ unit: 'pt', format: [fp.width, fp.height] });

        for (let pageNum = 0; pageNum < numPages; pageNum++) {
            showProgress((pageNum / numPages) * 100, `Redacting page ${pageNum + 1} of ${numPages}...`);

            if (pageNum > 0) {
                const pg = await pdf.getPage(pageNum + 1);
                const pv = pg.getViewport({ scale: 1 });
                doc.addPage([pv.width, pv.height]);
            }

            const page = await pdf.getPage(pageNum + 1);
            const baseVp = page.getViewport({ scale: 1 });
            const scale = Math.min(3, 4000 / Math.max(baseVp.width, baseVp.height));
            const viewport = page.getViewport({ scale });

            // 1. Render to canvas
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;

            // 2. Draw black rectangles for matches
            const pageMatches = matchesByPage[pageNum] || [];
            if (pageMatches.length > 0) {
                ctx.fillStyle = 'black';
                for (const match of pageMatches) {
                    ctx.fillRect(
                        match.bbox[0] * scale,
                        match.bbox[1] * scale,
                        (match.bbox[2] - match.bbox[0]) * scale,
                        (match.bbox[3] - match.bbox[1]) * scale
                    );
                }
            }

            // 3. Add to PDF as JPEG
            const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
            doc.addImage(jpegDataUrl, 'JPEG', 0, 0, baseVp.width, baseVp.height);

            // Allow UI to update
            await new Promise(r => setTimeout(r, 0));
        }

        showProgress(90, 'Saving PDF...');

        // 4. Download
        doc.save(fileName.textContent.replace('.pdf', '_anonymized.pdf'));

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

// Handle window resize for overlay positions (debounced)
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (matches.length > 0) {
            drawMatchOverlays();
        }
    }, 200);
});

// Initialize
console.log('PDF Anonymizer loaded. PDF.js ready.');
hideStatus();
