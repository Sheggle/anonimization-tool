import './styles.css';
import { PATTERNS, isPattern } from './patterns.js';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
import { createOfflineWorker, createOsdWorker } from './tesseract-loader.js';

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// State: array of loaded documents
// Each entry: { pdfDocument, pdfData, fileName, numPages }
let documents = [];

// Flat list of matches across all documents
// Each entry: { text, term, bbox, docIdx, pageNum, isManual? }
let matches = [];

// Flat map of page metadata keyed by `${docIdx}:${pageNum}`
// Each entry: { width, height, scale, bounds, rotation }
const pageImages = new Map();

// Drawing state for manual redaction boxes
let isDrawing = false;
let drawStartX = 0;
let drawStartY = 0;
let currentDrawingDocIdx = null;
let currentDrawingPage = null;
let drawPreviewElement = null;

// OCR cache keyed by `${docIdx}:${pageNum}`
const ocrCache = new Map();

// Worker pool for parallel OCR
const WORKER_POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 4);
let workerPool = [];
let workerPoolReady = false;

// OSD worker for orientation detection
let osdWorker = null;
let osdWorkerReady = false;

// Page rotation cache keyed by `${docIdx}:${pageNum}`
const pageRotations = new Map();

// DOM Elements
const fileInput = document.getElementById('fileInput');
const uploadZone = document.getElementById('uploadZone');
const fileInfo = document.getElementById('fileInfo');
const fileListEl = document.getElementById('fileList');
const totalPageCountEl = document.getElementById('totalPageCount');
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

// Cache key helpers
function pageKey(docIdx, pageNum) {
    return `${docIdx}:${pageNum}`;
}

function pageElementId(docIdx, pageNum) {
    return `page-${docIdx}-${pageNum}`;
}

// Coordinate transformation: display coordinates → PDF coordinates
function displayToPdfCoords(displayX, displayY, docIdx, pageNum, container) {
    const canvas = container.querySelector('canvas');
    const pageInfo = pageImages.get(pageKey(docIdx, pageNum));
    if (!pageInfo || !canvas) return null;

    const displayScale = canvas.offsetWidth / canvas.width;

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
        handleFiles(Array.from(e.dataTransfer.files));
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
        handleFiles(Array.from(e.target.files));
    }
});

async function handleFiles(files) {
    const pdfFiles = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfFiles.length === 0) {
        showStatus('Please select PDF file(s)', 'error');
        return;
    }

    // Reset state for a fresh selection
    documents = [];
    matches = [];
    pageImages.clear();
    ocrCache.clear();
    pageRotations.clear();
    matchList.classList.add('hidden');
    processBtn.disabled = true;
    scanBtn.disabled = true;

    showStatus(`Loading ${pdfFiles.length} PDF${pdfFiles.length !== 1 ? 's' : ''}...`);

    try {
        for (const file of pdfFiles) {
            const pdfData = new Uint8Array(await file.arrayBuffer());
            const pdfDocument = await pdfjsLib.getDocument({ data: pdfData.slice() }).promise;
            documents.push({
                pdfDocument,
                pdfData,
                fileName: file.name,
                numPages: pdfDocument.numPages
            });
        }

        renderFileList();
        fileInfo.classList.add('visible');
        scanBtn.disabled = !termsInput.value.trim();
        hideStatus();

        await generatePreviews();
    } catch (err) {
        console.error(err);
        showStatus(`Error loading PDF: ${err.message}`, 'error');
    }
}

function renderFileList() {
    fileListEl.innerHTML = '';
    let totalPages = 0;
    for (const doc of documents) {
        totalPages += doc.numPages;
        const item = document.createElement('div');
        item.className = 'file-list-item';
        item.innerHTML = `
            <span class="file-list-name">${escapeHtml(doc.fileName)}</span>
            <span class="file-list-pages">${doc.numPages} page${doc.numPages !== 1 ? 's' : ''}</span>
        `;
        fileListEl.appendChild(item);
    }
    totalPageCountEl.textContent = `${documents.length} file${documents.length !== 1 ? 's' : ''} · ${totalPages} total page${totalPages !== 1 ? 's' : ''}`;
}

async function generatePreviews() {
    if (documents.length === 0) return;

    previewPlaceholder.classList.add('hidden');
    previewScroll.classList.remove('hidden');
    previewScroll.innerHTML = '';

    await initOsdWorker();

    for (let docIdx = 0; docIdx < documents.length; docIdx++) {
        const { pdfDocument, fileName, numPages } = documents[docIdx];

        // Document separator
        const separator = document.createElement('div');
        separator.className = 'doc-separator';
        separator.innerHTML = `
            <div class="doc-name">${escapeHtml(fileName)}</div>
            <div class="doc-meta">File ${docIdx + 1} of ${documents.length} · ${numPages} page${numPages !== 1 ? 's' : ''}</div>
        `;
        previewScroll.appendChild(separator);

        for (let i = 0; i < numPages; i++) {
            const page = await pdfDocument.getPage(i + 1);
            const baseViewport = page.getViewport({ scale: 1 });
            const origWidth = baseViewport.width;
            const origHeight = baseViewport.height;

            const scale = Math.min(800 / origWidth, 1.5);
            const viewport = page.getViewport({ scale });

            let canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport }).promise;

            const rotation = await detectPageOrientation(docIdx, i);
            if (rotation !== 0) {
                canvas = rotateCanvas(canvas, rotation);
            }

            const isSwapped = rotation === 90 || rotation === 270;
            const width = isSwapped ? origHeight : origWidth;
            const height = isSwapped ? origWidth : origHeight;

            pageImages.set(pageKey(docIdx, i), {
                width,
                height,
                scale,
                bounds: [0, 0, width, height],
                rotation
            });

            const container = document.createElement('div');
            container.className = 'page-preview';
            container.id = pageElementId(docIdx, i);

            const label = document.createElement('div');
            label.className = 'page-label';
            label.textContent = `Page ${i + 1}`;

            container.appendChild(canvas);
            container.appendChild(label);
            previewScroll.appendChild(container);

            attachDrawingHandlers(container, docIdx, i);

            await new Promise(r => setTimeout(r, 0));
        }
    }
}

// Term input handler
termsInput.addEventListener('input', () => {
    scanBtn.disabled = documents.length === 0 || !termsInput.value.trim();
});

// Estimate bounding box for a substring within a text block (fallback)
function estimateBbox(block, charIndex, charLength) {
    const text = block.text;
    const bbox = block.bbox;

    if (!text || text.length === 0) return bbox;

    const lineWidth = bbox[2] - bbox[0];
    const charWidth = lineWidth / text.length;

    const x0 = bbox[0] + charIndex * charWidth;
    const x1 = bbox[0] + (charIndex + charLength) * charWidth;

    return [x0, bbox[1], x1, bbox[3]];
}

// Find precise bounding box using word-level OCR data
function findMatchBbox(block, matchText, charIndex) {
    if (!block.words || block.words.length === 0) {
        return estimateBbox(block, charIndex, matchText.length);
    }

    let charPos = 0;
    const charToWord = [];
    for (const word of block.words) {
        for (let i = 0; i < word.text.length; i++) {
            charToWord.push({ word, posInWord: i });
        }
        charPos += word.text.length;
        if (charPos < block.text.length && block.text[charPos] === ' ') {
            charToWord.push(null);
            charPos++;
        }
    }

    const startIdx = charIndex;
    const endIdx = charIndex + matchText.length - 1;

    const wordRanges = new Map();
    for (let i = startIdx; i <= endIdx && i < charToWord.length; i++) {
        const entry = charToWord[i];
        if (entry) {
            if (!wordRanges.has(entry.word)) {
                wordRanges.set(entry.word, { startPos: entry.posInWord, endPos: entry.posInWord });
            } else {
                wordRanges.get(entry.word).endPos = entry.posInWord;
            }
        }
    }

    if (wordRanges.size === 0) {
        return estimateBbox(block, charIndex, matchText.length);
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const [word, range] of wordRanges) {
        const wordLen = word.text.length;
        const wordWidth = word.bbox[2] - word.bbox[0];
        const charWidth = wordWidth / wordLen;

        if (range.startPos === 0 && range.endPos === wordLen - 1) {
            minX = Math.min(minX, word.bbox[0]);
            maxX = Math.max(maxX, word.bbox[2]);
        } else {
            const x0 = word.bbox[0] + range.startPos * charWidth;
            const x1 = word.bbox[0] + (range.endPos + 1) * charWidth;
            minX = Math.min(minX, x0);
            maxX = Math.max(maxX, x1);
        }
        minY = Math.min(minY, word.bbox[1]);
        maxY = Math.max(maxY, word.bbox[3]);
    }

    return [minX, minY, maxX, maxY];
}

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

async function initOsdWorker() {
    if (osdWorkerReady) return;

    try {
        osdWorker = await createOsdWorker({ logger: () => {} });
        osdWorkerReady = true;
    } catch (err) {
        console.error('[OSD] Failed to initialize OSD worker:', err);
        osdWorker = null;
    }
}

function rotateCanvas(canvas, degrees) {
    if (degrees === 0) return canvas;

    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const rotatedCanvas = document.createElement('canvas');
    const rotatedCtx = rotatedCanvas.getContext('2d');

    if (degrees === 180) {
        rotatedCanvas.width = canvas.width;
        rotatedCanvas.height = canvas.height;
        rotatedCtx.translate(canvas.width, canvas.height);
        rotatedCtx.rotate(Math.PI);
    } else if (degrees === 90) {
        rotatedCanvas.width = canvas.height;
        rotatedCanvas.height = canvas.width;
        rotatedCtx.translate(canvas.height, 0);
        rotatedCtx.rotate(Math.PI / 2);
    } else if (degrees === 270) {
        rotatedCanvas.width = canvas.height;
        rotatedCanvas.height = canvas.width;
        rotatedCtx.translate(0, canvas.width);
        rotatedCtx.rotate(-Math.PI / 2);
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    tempCanvas.getContext('2d').putImageData(imageData, 0, 0);
    rotatedCtx.drawImage(tempCanvas, 0, 0);

    return rotatedCanvas;
}

async function detectPageOrientation(docIdx, pageNum) {
    const key = pageKey(docIdx, pageNum);
    if (pageRotations.has(key)) {
        return pageRotations.get(key);
    }

    if (!osdWorker) {
        pageRotations.set(key, 0);
        return 0;
    }

    try {
        const page = await documents[docIdx].pdfDocument.getPage(pageNum + 1);
        const scale = Math.max(150 / 72, 1);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        const result = await osdWorker.detect(canvas);
        const rotation = result.rotate || 0;

        pageRotations.set(key, rotation);
        return rotation;
    } catch (err) {
        console.error(`[OSD] Orientation detection failed for doc ${docIdx} page ${pageNum + 1}:`, err);
        pageRotations.set(key, 0);
        return 0;
    }
}

async function ocrPageWithWorker(docIdx, pageNum, worker) {
    const key = pageKey(docIdx, pageNum);
    if (ocrCache.has(key)) {
        return { docIdx, pageNum, blocks: ocrCache.get(key) };
    }

    const page = await documents[docIdx].pdfDocument.getPage(pageNum + 1);

    const scale = Math.max(300 / 72, 2);
    const viewport = page.getViewport({ scale });

    let canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const rotation = await detectPageOrientation(docIdx, pageNum);
    if (rotation !== 0) {
        canvas = rotateCanvas(canvas, rotation);
    }

    const result = await worker.recognize(canvas);

    const blocks = [];
    for (const line of result.data.lines) {
        const words = line.words.map(word => ({
            text: word.text,
            bbox: [
                word.bbox.x0 / scale,
                word.bbox.y0 / scale,
                word.bbox.x1 / scale,
                word.bbox.y1 / scale
            ]
        }));

        blocks.push({
            text: line.text,
            bbox: [
                line.bbox.x0 / scale,
                line.bbox.y0 / scale,
                line.bbox.x1 / scale,
                line.bbox.y1 / scale
            ],
            type: 'ocr',
            confidence: line.confidence,
            words
        });
    }

    ocrCache.set(key, blocks);
    return { docIdx, pageNum, blocks };
}

async function ocrPagesParallel(pageRefs, onProgress) {
    let completed = 0;

    for (let i = 0; i < pageRefs.length; i += WORKER_POOL_SIZE) {
        const batch = pageRefs.slice(i, i + WORKER_POOL_SIZE);

        const batchPromises = batch.map(({ docIdx, pageNum }, idx) =>
            ocrPageWithWorker(docIdx, pageNum, workerPool[idx])
        );

        await Promise.all(batchPromises);

        completed += batch.length;
        onProgress(completed, pageRefs.length);
    }
}

// Scan for matches
scanBtn.addEventListener('click', async () => {
    if (documents.length === 0 || !termsInput.value.trim()) return;

    showStatus('Scanning for matches...');
    // Preserve manual redactions when rescanning
    const manualMatches = matches.filter(m => m.isManual);
    matches = [...manualMatches];

    const terms = termsInput.value
        .split('\n')
        .map(t => t.trim())
        .filter(t => t);

    // Collect all pages across all documents
    const allPages = [];
    for (let docIdx = 0; docIdx < documents.length; docIdx++) {
        for (let p = 0; p < documents[docIdx].numPages; p++) {
            allPages.push({ docIdx, pageNum: p });
        }
    }

    const uncachedPages = allPages.filter(({ docIdx, pageNum }) => !ocrCache.has(pageKey(docIdx, pageNum)));

    if (uncachedPages.length > 0) {
        try {
            await initWorkerPool();
        } catch (err) {
            return;
        }

        showStatus(`Running OCR on ${uncachedPages.length} page${uncachedPages.length !== 1 ? 's' : ''}...`);

        await ocrPagesParallel(uncachedPages, (done, total) => {
            showProgress((done / total) * 50, `OCR: ${done}/${total} pages`);
        });
    }

    // Search OCR results
    for (let i = 0; i < allPages.length; i++) {
        const { docIdx, pageNum } = allPages[i];
        showProgress(50 + (i / allPages.length) * 50, `Searching ${documents[docIdx].fileName} page ${pageNum + 1}...`);

        const blocks = ocrCache.get(pageKey(docIdx, pageNum));
        if (!blocks) continue;

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

            for (const block of blocks) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(block.text)) !== null) {
                    if (!validate(match[0])) continue;
                    const estBbox = findMatchBbox(block, match[0], match.index);
                    matches.push({
                        text: match[0],
                        term,
                        bbox: estBbox,
                        docIdx,
                        pageNum
                    });
                }
            }
        }

        await new Promise(r => setTimeout(r, 0));
    }

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

    // Group by doc then page
    const byDocPage = new Map();
    for (const match of matches) {
        const key = pageKey(match.docIdx, match.pageNum);
        if (!byDocPage.has(key)) byDocPage.set(key, []);
        byDocPage.get(key).push(match);
    }

    for (const [key, pageMatches] of byDocPage) {
        const [docIdx, pageNum] = key.split(':').map(Number);
        const label = documents.length > 1
            ? `${documents[docIdx].fileName} · Page ${pageNum + 1}`
            : `Page ${pageNum + 1}`;

        for (const match of pageMatches.slice(0, 5)) {
            const item = document.createElement('div');
            item.className = 'match-item';
            item.innerHTML = `
                <span class="match-term">"${escapeHtml(match.text.substring(0, 30))}${match.text.length > 30 ? '...' : ''}"</span>
                <span class="match-page">${escapeHtml(label)}</span>
            `;
            matchItems.appendChild(item);
        }
        if (pageMatches.length > 5) {
            const more = document.createElement('div');
            more.className = 'match-item';
            more.innerHTML = `<span style="color: var(--text-muted)">...and ${pageMatches.length - 5} more on ${escapeHtml(label)}</span>`;
            matchItems.appendChild(more);
        }
    }

    drawMatchOverlays();
}

function createOverlayForMatch(match, index) {
    const pageContainer = document.getElementById(pageElementId(match.docIdx, match.pageNum));
    if (!pageContainer) return;

    const canvas = pageContainer.querySelector('canvas');
    const pageInfo = pageImages.get(pageKey(match.docIdx, match.pageNum));
    if (!pageInfo || !canvas) return;

    const bbox = match.bbox;
    const scale = pageInfo.scale;

    const x = bbox[0] * scale;
    const y = bbox[1] * scale;
    const width = (bbox[2] - bbox[0]) * scale;
    const height = (bbox[3] - bbox[1]) * scale;

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
    document.querySelectorAll('.match-overlay').forEach(el => el.remove());

    for (let i = 0; i < matches.length; i++) {
        createOverlayForMatch(matches[i], i);
    }
}

function addManualRedaction(docIdx, pageNum, bbox) {
    const match = {
        text: '[Manual Redaction]',
        term: '__manual__',
        bbox,
        docIdx,
        pageNum,
        isManual: true
    };
    matches.push(match);

    createOverlayForMatch(match, matches.length - 1);

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

function handleDrawStart(e, docIdx, pageNum, container) {
    if (e.button !== 0) return;

    if (e.target.classList.contains('match-overlay') ||
        e.target.classList.contains('overlay-delete-btn') ||
        e.target.closest('.manual-overlay')) {
        return;
    }

    const canvas = container.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();

    isDrawing = true;
    currentDrawingDocIdx = docIdx;
    currentDrawingPage = pageNum;
    drawStartX = e.clientX - rect.left;
    drawStartY = e.clientY - rect.top;

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

    const left = Math.min(drawStartX, currentX);
    const top = Math.min(drawStartY, currentY);
    const width = Math.abs(currentX - drawStartX);
    const height = Math.abs(currentY - drawStartY);

    drawPreviewElement.style.left = `${left}px`;
    drawPreviewElement.style.top = `${top}px`;
    drawPreviewElement.style.width = `${width}px`;
    drawPreviewElement.style.height = `${height}px`;
}

function handleDrawEnd(e, docIdx, pageNum, container) {
    if (!isDrawing) return;

    const canvas = container.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();

    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;

    const left = Math.min(drawStartX, endX);
    const top = Math.min(drawStartY, endY);
    const width = Math.abs(endX - drawStartX);
    const height = Math.abs(endY - drawStartY);

    if (drawPreviewElement) {
        drawPreviewElement.remove();
        drawPreviewElement = null;
    }

    if (width >= 5 && height >= 5) {
        const topLeft = displayToPdfCoords(left, top, docIdx, pageNum, container);
        const bottomRight = displayToPdfCoords(left + width, top + height, docIdx, pageNum, container);

        if (topLeft && bottomRight) {
            const bbox = [
                Math.min(topLeft.x, bottomRight.x),
                Math.min(topLeft.y, bottomRight.y),
                Math.max(topLeft.x, bottomRight.x),
                Math.max(topLeft.y, bottomRight.y)
            ];
            addManualRedaction(docIdx, pageNum, bbox);
        }
    }

    isDrawing = false;
    currentDrawingDocIdx = null;
    currentDrawingPage = null;
}

function handleDrawCancel() {
    if (drawPreviewElement) {
        drawPreviewElement.remove();
        drawPreviewElement = null;
    }
    isDrawing = false;
    currentDrawingDocIdx = null;
    currentDrawingPage = null;
}

function attachDrawingHandlers(container, docIdx, pageNum) {
    container.addEventListener('mousedown', (e) => handleDrawStart(e, docIdx, pageNum, container));
    container.addEventListener('mousemove', (e) => handleDrawMove(e, container));
    container.addEventListener('mouseup', (e) => handleDrawEnd(e, docIdx, pageNum, container));
    container.addEventListener('mouseleave', handleDrawCancel);
}

// Build a single redacted PDF for a given document
async function buildRedactedPdf(docIdx, onPageProgress) {
    const { pdfData } = documents[docIdx];
    const pdf = await pdfjsLib.getDocument({ data: pdfData.slice() }).promise;
    const numPages = pdf.numPages;

    const docMatches = matches.filter(m => m.docIdx === docIdx);
    const matchesByPage = {};
    for (const match of docMatches) {
        if (!matchesByPage[match.pageNum]) matchesByPage[match.pageNum] = [];
        matchesByPage[match.pageNum].push(match);
    }

    const firstPage = await pdf.getPage(1);
    const fp = firstPage.getViewport({ scale: 1 });
    const firstRotation = pageRotations.get(pageKey(docIdx, 0)) || 0;
    const firstSwapped = firstRotation === 90 || firstRotation === 270;
    const firstWidth = firstSwapped ? fp.height : fp.width;
    const firstHeight = firstSwapped ? fp.width : fp.height;
    const doc = new jsPDF({ unit: 'pt', format: [firstWidth, firstHeight] });

    for (let pageNum = 0; pageNum < numPages; pageNum++) {
        if (onPageProgress) onPageProgress(pageNum, numPages);

        const page = await pdf.getPage(pageNum + 1);
        const baseVp = page.getViewport({ scale: 1 });
        const rotation = pageRotations.get(pageKey(docIdx, pageNum)) || 0;
        const isSwapped = rotation === 90 || rotation === 270;

        const correctedWidth = isSwapped ? baseVp.height : baseVp.width;
        const correctedHeight = isSwapped ? baseVp.width : baseVp.height;

        if (pageNum > 0) {
            doc.addPage([correctedWidth, correctedHeight]);
        }

        const scale = Math.min(3, 4000 / Math.max(baseVp.width, baseVp.height));
        const viewport = page.getViewport({ scale });

        let canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        if (rotation !== 0) {
            canvas = rotateCanvas(canvas, rotation);
        }

        const pageMatches = matchesByPage[pageNum] || [];
        if (pageMatches.length > 0) {
            const rotatedCtx = canvas.getContext('2d');
            rotatedCtx.fillStyle = 'white';
            for (const match of pageMatches) {
                rotatedCtx.fillRect(
                    match.bbox[0] * scale,
                    match.bbox[1] * scale,
                    (match.bbox[2] - match.bbox[0]) * scale,
                    (match.bbox[3] - match.bbox[1]) * scale
                );
            }
        }

        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        doc.addImage(jpegDataUrl, 'JPEG', 0, 0, correctedWidth, correctedHeight);

        await new Promise(r => setTimeout(r, 0));
    }

    return doc.output('blob');
}

function anonymizedFileName(originalName) {
    return originalName.replace(/\.pdf$/i, '') + '_anonymized.pdf';
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Process and download
processBtn.addEventListener('click', async () => {
    if (documents.length === 0 || matches.length === 0) return;

    showStatus('Applying redactions...');
    processBtn.disabled = true;
    scanBtn.disabled = true;

    try {
        const totalPages = documents.reduce((s, d) => s + d.numPages, 0);
        let pagesDone = 0;

        const blobs = [];
        for (let docIdx = 0; docIdx < documents.length; docIdx++) {
            const doc = documents[docIdx];
            const blob = await buildRedactedPdf(docIdx, (pageNum, numPages) => {
                const percent = ((pagesDone + pageNum) / totalPages) * 100;
                showProgress(percent, `Redacting ${doc.fileName} (page ${pageNum + 1}/${numPages})...`);
            });
            pagesDone += doc.numPages;
            blobs.push({ blob, fileName: anonymizedFileName(doc.fileName) });
        }

        if (blobs.length === 1) {
            showProgress(95, 'Saving PDF...');
            downloadBlob(blobs[0].blob, blobs[0].fileName);
        } else {
            showProgress(95, 'Creating zip archive...');
            const zip = new JSZip();
            // Ensure unique filenames inside the zip
            const seen = new Map();
            for (const { blob, fileName } of blobs) {
                let name = fileName;
                if (seen.has(name)) {
                    const count = seen.get(name) + 1;
                    seen.set(name, count);
                    const base = name.replace(/\.pdf$/i, '');
                    name = `${base} (${count}).pdf`;
                } else {
                    seen.set(name, 1);
                }
                zip.file(name, blob);
            }
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            downloadBlob(zipBlob, 'anonymized_pdfs.zip');
        }

        hideProgress();
        showStatus(
            blobs.length === 1
                ? 'PDF anonymized and downloaded successfully!'
                : `${blobs.length} PDFs anonymized and zipped successfully!`,
            'success'
        );
    } catch (err) {
        console.error(err);
        showStatus(`Error during redaction: ${err.message}`, 'error');
    } finally {
        processBtn.disabled = false;
        scanBtn.disabled = false;
    }
});

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

console.log('PDF Anonymizer loaded. PDF.js ready.');
hideStatus();
