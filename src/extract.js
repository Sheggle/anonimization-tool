import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createOfflineWorker } from './tesseract-loader.js';

// Inline styles
const styles = `
:root {
    --bg: #1a1a2e;
    --surface: #16213e;
    --primary: #e94560;
    --text: #eee;
    --text-muted: #888;
    --border: #333;
    --success: #4ade80;
    --warning: #fbbf24;
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    line-height: 1.5;
}

.container {
    max-width: 1000px;
    margin: 0 auto;
    padding: 2rem;
}

header {
    text-align: center;
    margin-bottom: 2rem;
}

header h1 {
    font-size: 2rem;
    margin-bottom: 0.5rem;
}

header p {
    color: var(--text-muted);
}

.grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
}

@media (max-width: 800px) {
    .grid {
        grid-template-columns: 1fr;
    }
}

.card {
    background: var(--surface);
    border-radius: 12px;
    padding: 1.5rem;
}

.card h2 {
    font-size: 1.1rem;
    margin-bottom: 1rem;
}

.upload-zone {
    border: 2px dashed var(--border);
    border-radius: 8px;
    padding: 2rem;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
}

.upload-zone:hover,
.upload-zone.dragover {
    border-color: var(--primary);
    background: rgba(233, 69, 96, 0.1);
}

.upload-zone input {
    display: none;
}

.upload-zone .icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
}

.file-info {
    margin-top: 1rem;
    padding: 0.75rem;
    background: rgba(74, 222, 128, 0.1);
    border-radius: 6px;
    font-size: 0.9rem;
    display: none;
}

.file-info.visible {
    display: block;
}

.page-input {
    width: 100%;
    padding: 0.75rem 1rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 1rem;
}

.page-input:focus {
    outline: none;
    border-color: var(--primary);
}

.help-text {
    margin-top: 0.75rem;
    font-size: 0.85rem;
    color: var(--text-muted);
}

.help-text code {
    background: var(--bg);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: var(--primary);
}

.preview-container {
    grid-column: 1 / -1;
}

.output-text {
    width: 100%;
    min-height: 300px;
    max-height: 500px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    color: var(--text);
    font-family: monospace;
    font-size: 0.9rem;
    resize: vertical;
}

.actions {
    grid-column: 1 / -1;
    display: flex;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
}

button {
    background: var(--primary);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    font-size: 1rem;
    cursor: pointer;
    transition: opacity 0.2s, transform 0.1s;
}

button:hover:not(:disabled) {
    opacity: 0.9;
}

button:active:not(:disabled) {
    transform: scale(0.98);
}

button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

button.secondary {
    background: var(--surface);
    border: 1px solid var(--border);
}

.progress-container {
    flex: 1;
    min-width: 200px;
}

.progress-bar {
    height: 8px;
    background: var(--bg);
    border-radius: 4px;
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    background: var(--primary);
    width: 0%;
    transition: width 0.3s;
}

.progress-text {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
}

.status {
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    display: none;
}

.status.visible {
    display: block;
}

.status.error {
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid #ef4444;
}

.status.success {
    background: rgba(74, 222, 128, 0.2);
    border: 1px solid var(--success);
}

.status.loading {
    background: rgba(251, 191, 36, 0.2);
    border: 1px solid var(--warning);
}

.spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--text-muted);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-right: 0.5rem;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.hidden {
    display: none !important;
}
`;

// Inject styles
const styleEl = document.createElement('style');
styleEl.textContent = styles;
document.head.appendChild(styleEl);

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// State
let pdfDocument = null;
let extractedText = '';

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
const pageInput = document.getElementById('pageInput');
const extractBtn = document.getElementById('extractBtn');
const downloadBtn = document.getElementById('downloadBtn');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const outputText = document.getElementById('outputText');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusEl = document.getElementById('status');

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

// Parse page specification like "1,3,5-10,15"
function parsePageSpec(spec, totalPages) {
    if (!spec || !spec.trim()) {
        // Return all pages
        return Array.from({ length: totalPages }, (_, i) => i);
    }

    const pages = new Set();
    const parts = spec.split(',').map(p => p.trim()).filter(p => p);

    for (const part of parts) {
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(n => parseInt(n.trim(), 10));
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
                    pages.add(i - 1); // Convert to 0-indexed
                }
            }
        } else {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= totalPages) {
                pages.add(num - 1); // Convert to 0-indexed
            }
        }
    }

    return Array.from(pages).sort((a, b) => a - b);
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

    showStatus('Loading PDF...');

    try {
        const pdfData = new Uint8Array(await file.arrayBuffer());
        pdfDocument = await pdfjsLib.getDocument({ data: pdfData }).promise;

        const numPages = pdfDocument.numPages;

        fileName.textContent = file.name;
        pageCount.textContent = `${numPages} page${numPages !== 1 ? 's' : ''}`;
        fileInfo.classList.add('visible');

        extractBtn.disabled = false;
        hideStatus();

        // Reset output
        extractedText = '';
        outputText.value = '';
        outputText.classList.add('hidden');
        previewPlaceholder.classList.remove('hidden');
        downloadBtn.disabled = true;

    } catch (err) {
        console.error(err);
        showStatus(`Error loading PDF: ${err.message}`, 'error');
    }
}

// Initialize worker pool
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
    } catch (err) {
        console.error('Failed to initialize worker pool:', err);
        showStatus(`Failed to initialize OCR workers: ${err.message}`, 'error');
        throw err;
    }
}

// OCR a single page
async function ocrPage(pageNum, worker) {
    const page = await pdfDocument.getPage(pageNum + 1); // PDF.js is 1-indexed

    // Render at high resolution for OCR
    const scale = Math.max(300 / 72, 2); // At least 300 DPI
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Run OCR
    const result = await worker.recognize(canvas);

    return result.data.text || '';
}

// Process pages in parallel
async function extractPagesParallel(pageNumbers, onProgress) {
    const results = new Map();
    let completed = 0;

    // Process in batches
    for (let i = 0; i < pageNumbers.length; i += WORKER_POOL_SIZE) {
        const batch = pageNumbers.slice(i, i + WORKER_POOL_SIZE);

        const batchPromises = batch.map((pageNum, idx) =>
            ocrPage(pageNum, workerPool[idx]).then(text => ({ pageNum, text }))
        );

        const batchResults = await Promise.all(batchPromises);

        for (const { pageNum, text } of batchResults) {
            results.set(pageNum, text);
        }

        completed += batch.length;
        onProgress(completed, pageNumbers.length);
    }

    return results;
}

// Extract button handler
extractBtn.addEventListener('click', async () => {
    if (!pdfDocument) return;

    const pageSpec = pageInput.value.trim();
    const pages = parsePageSpec(pageSpec, pdfDocument.numPages);

    if (pages.length === 0) {
        showStatus('No valid pages specified', 'error');
        return;
    }

    extractBtn.disabled = true;
    downloadBtn.disabled = true;

    try {
        await initWorkerPool();

        showStatus(`Extracting text from ${pages.length} page${pages.length !== 1 ? 's' : ''}...`);

        const results = await extractPagesParallel(pages, (done, total) => {
            showProgress((done / total) * 100, `OCR: ${done}/${total} pages`);
        });

        // Build output text
        const outputParts = [];
        for (const pageNum of pages) {
            const text = results.get(pageNum) || '';
            outputParts.push(`--- Page ${pageNum + 1} ---\n${text.trim()}`);
        }

        extractedText = outputParts.join('\n\n');

        // Show output
        previewPlaceholder.classList.add('hidden');
        outputText.classList.remove('hidden');
        outputText.value = extractedText;

        hideProgress();
        showStatus(`Extracted ${extractedText.length} characters from ${pages.length} page${pages.length !== 1 ? 's' : ''}`, 'success');

        downloadBtn.disabled = false;

    } catch (err) {
        console.error(err);
        showStatus(`Error during extraction: ${err.message}`, 'error');
    } finally {
        extractBtn.disabled = false;
    }
});

// Download button handler
downloadBtn.addEventListener('click', () => {
    if (!extractedText) return;

    const blob = new Blob([extractedText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (fileName.textContent || 'document').replace('.pdf', '_extracted.txt');
    a.click();
    URL.revokeObjectURL(url);
});

// Initialize
console.log('PDF Text Extractor loaded.');
hideStatus();
