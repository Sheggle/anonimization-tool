/**
 * Tesseract.js Offline Loader
 *
 * This module provides a fully offline-capable Tesseract.js setup by:
 * 1. Bundling the worker script inline with embedded WASM core
 * 2. Bundling language data inline (gzipped)
 */

// Import the worker script as raw text
import workerScript from 'tesseract.js/dist/worker.min.js?raw';

// Import the WASM core as raw text (contains embedded base64 WASM)
import coreScript from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?raw';

// Import language data as base64 (gzipped .traineddata.gz files)
import nldDataBase64 from './lang-data/nld.js';
import engDataBase64 from './lang-data/eng.js';
import osdDataBase64 from './lang-data/osd.js';

// Convert base64 to Uint8Array
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Cached language data
const languageData = {
  nld: null,
  eng: null,
  osd: null
};

/**
 * Circularize the recognition result to create flat arrays
 * This mimics what Tesseract.js does internally
 */
function circularize(page) {
  const blocks = [];
  const paragraphs = [];
  const lines = [];
  const words = [];
  const symbols = [];

  if (page && page.blocks) {
    page.blocks.forEach((block) => {
      if (block.paragraphs) {
        block.paragraphs.forEach((paragraph) => {
          if (paragraph.lines) {
            paragraph.lines.forEach((line) => {
              if (line.words) {
                line.words.forEach((word) => {
                  if (word.symbols) {
                    word.symbols.forEach((sym) => {
                      symbols.push({ ...sym, page, block, paragraph, line, word });
                    });
                  }
                  words.push({ ...word, page, block, paragraph, line });
                });
              }
              lines.push({ ...line, page, block, paragraph });
            });
          }
          paragraphs.push({ ...paragraph, page, block });
        });
      }
      blocks.push({ ...block, page });
    });
  }

  return { ...page, blocks, paragraphs, lines, words, symbols };
}

/**
 * Convert various image formats to Uint8Array for the worker
 * Based on Tesseract.js loadImage function
 */
async function loadImage(image) {
  let data = image;

  if (typeof image === 'string') {
    // Base64 data URL
    if (/data:image\/([a-zA-Z]*);base64,([^"]*)/.test(image)) {
      const base64 = image.split(',')[1];
      const binaryString = atob(base64);
      data = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        data[i] = binaryString.charCodeAt(i);
      }
      return data;
    }
  } else if (image instanceof HTMLCanvasElement) {
    // Canvas element - convert to blob then to array buffer
    return new Promise((resolve) => {
      image.toBlob(async (blob) => {
        const arrayBuffer = await blob.arrayBuffer();
        resolve(new Uint8Array(arrayBuffer));
      }, 'image/png');
    });
  } else if (image instanceof ImageData) {
    // ImageData - draw to canvas first
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').putImageData(image, 0, 0);
    return loadImage(canvas);
  } else if (image instanceof Blob || image instanceof File) {
    const arrayBuffer = await image.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } else if (image instanceof Uint8Array) {
    return image;
  } else if (ArrayBuffer.isView(image)) {
    return new Uint8Array(image.buffer);
  }

  return new Uint8Array(data);
}

function getLanguageData(lang) {
  if (!languageData[lang]) {
    const base64Map = { nld: nldDataBase64, eng: engDataBase64, osd: osdDataBase64 };
    languageData[lang] = base64ToUint8Array(base64Map[lang]);
  }
  return languageData[lang];
}

/**
 * Create a combined worker script that includes the WASM core.
 * This avoids the importScripts issue with blob URLs.
 */
function createCombinedWorkerScript() {
  // The core script defines `var TesseractCore = ...`
  // We need to ensure it's available on the global scope that the worker checks
  // The worker checks `global.TesseractCore` where global = self in web workers
  const combinedScript = `
// === Setup global reference ===
var global = self;

// === Tesseract Core (embedded) ===
${coreScript}

// === Expose TesseractCore on global/self ===
// The core script creates var TesseractCore, make sure it's on global
if (typeof TesseractCore !== 'undefined') {
  self.TesseractCore = TesseractCore;
  global.TesseractCore = TesseractCore;
}

// === Tesseract Worker ===
${workerScript}
`;
  return combinedScript;
}

/**
 * Create a custom Tesseract worker with fully inlined resources.
 */
function createInlineWorker() {
  const script = createCombinedWorkerScript();
  const blob = new Blob([script], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(blobUrl);
  return worker;
}

/**
 * Create a Tesseract worker with bundled offline resources
 *
 * @param {Object} options - Additional options
 * @param {Function} options.logger - Logger function for progress updates
 * @returns {Promise<Object>} Tesseract worker instance
 */
export async function createOfflineWorker(options = {}) {
  const { logger = () => {} } = options;

  // Create worker directly from combined script
  const worker = createInlineWorker();

  // Worker communication helpers
  let jobCounter = 0;
  const resolvers = {};
  const rejecters = {};

  worker.onmessage = (e) => {
    const { jobId, status, action, data } = e.data;
    const promiseId = `${action}-${jobId}`;

    if (status === 'resolve') {
      if (resolvers[promiseId]) {
        resolvers[promiseId](data);
        delete resolvers[promiseId];
        delete rejecters[promiseId];
      }
    } else if (status === 'reject') {
      if (rejecters[promiseId]) {
        rejecters[promiseId](new Error(data));
        delete resolvers[promiseId];
        delete rejecters[promiseId];
      }
    } else if (status === 'progress') {
      logger(data);
    }
  };

  worker.onerror = (e) => {
    console.error('Worker error:', e);
  };

  const sendMessage = (action, payload) => {
    return new Promise((resolve, reject) => {
      const jobId = `Job-${++jobCounter}`;
      const promiseId = `${action}-${jobId}`;
      resolvers[promiseId] = resolve;
      rejecters[promiseId] = reject;

      worker.postMessage({
        workerId: 'Worker-1',
        jobId,
        action,
        payload
      });
    });
  };

  // Initialize: load the WASM core
  // Core is already embedded and exposed on global.TesseractCore
  logger({ status: 'loading tesseract core', progress: 0 });
  await sendMessage('load', {
    options: {
      lstmOnly: true,
      corePath: 'embedded', // Won't be used since TesseractCore is already defined
      logging: false
    }
  });

  // Load language data
  logger({ status: 'loading language traineddata', progress: 0 });

  // Prepare language data - pass as objects with code and data
  const langs = [
    { code: 'nld', data: getLanguageData('nld') },
    { code: 'eng', data: getLanguageData('eng') }
  ];

  await sendMessage('loadLanguage', {
    langs: langs,
    options: {
      gzip: true,
      lstmOnly: true,
      cacheMethod: 'none'
    }
  });

  // Initialize the API
  logger({ status: 'initializing api', progress: 0 });
  await sendMessage('initialize', {
    langs: 'nld+eng',
    oem: 1, // LSTM_ONLY
    config: {}
  });

  logger({ status: 'ready', progress: 1 });

  // Return worker interface compatible with Tesseract.js
  return {
    recognize: async (image, opts = {}, output = { blocks: true, text: true, hocr: true, tsv: true }) => {
      // Convert image to Uint8Array - the worker expects binary image data
      let imageData = await loadImage(image);

      const result = await sendMessage('recognize', {
        image: imageData,
        options: opts,
        output
      });
      // Apply circularize-like transformation to create flat arrays
      // The worker returns nested blocks, we need to flatten to get words array
      const data = circularize(result);
      return { data };
    },

    terminate: async () => {
      await sendMessage('terminate', {});
      worker.terminate();
    },

    setParameters: async (params) => {
      return sendMessage('setParameters', { params });
    }
  };
}

/**
 * Create a Tesseract worker specifically for Orientation and Script Detection (OSD)
 *
 * @param {Object} options - Additional options
 * @param {Function} options.logger - Logger function for progress updates
 * @returns {Promise<Object>} OSD worker instance
 */
export async function createOsdWorker(options = {}) {
  const { logger = () => {} } = options;

  // Create worker directly from combined script
  const worker = createInlineWorker();

  // Worker communication helpers
  let jobCounter = 0;
  const resolvers = {};
  const rejecters = {};

  worker.onmessage = (e) => {
    const { jobId, status, action, data } = e.data;
    const promiseId = `${action}-${jobId}`;

    if (status === 'resolve') {
      if (resolvers[promiseId]) {
        resolvers[promiseId](data);
        delete resolvers[promiseId];
        delete rejecters[promiseId];
      }
    } else if (status === 'reject') {
      if (rejecters[promiseId]) {
        rejecters[promiseId](new Error(data));
        delete resolvers[promiseId];
        delete rejecters[promiseId];
      }
    } else if (status === 'progress') {
      logger(data);
    }
  };

  worker.onerror = (e) => {
    console.error('OSD Worker error:', e);
  };

  const sendMessage = (action, payload) => {
    return new Promise((resolve, reject) => {
      const jobId = `Job-${++jobCounter}`;
      const promiseId = `${action}-${jobId}`;
      resolvers[promiseId] = resolve;
      rejecters[promiseId] = reject;

      worker.postMessage({
        workerId: 'OSD-Worker-1',
        jobId,
        action,
        payload
      });
    });
  };

  // Initialize: load the WASM core
  logger({ status: 'loading tesseract core for OSD', progress: 0 });
  await sendMessage('load', {
    options: {
      lstmOnly: false, // OSD requires legacy mode
      corePath: 'embedded',
      logging: false
    }
  });

  // Load OSD language data
  logger({ status: 'loading OSD traineddata', progress: 0 });

  const langs = [{ code: 'osd', data: getLanguageData('osd') }];

  await sendMessage('loadLanguage', {
    langs: langs,
    options: {
      gzip: true,
      lstmOnly: false,
      cacheMethod: 'none'
    }
  });

  // Initialize the API with OSD
  logger({ status: 'initializing OSD api', progress: 0 });
  await sendMessage('initialize', {
    langs: 'osd',
    oem: 0, // OEM_TESSERACT_ONLY (required for OSD)
    config: {}
  });

  logger({ status: 'OSD ready', progress: 1 });

  // Return worker interface
  return {
    /**
     * Detect orientation of an image
     * @param {HTMLCanvasElement|ImageData|Uint8Array} image - Image to analyze
     * @returns {Promise<{orientation: number, rotate: number, orientationConfidence: number}>}
     *   orientation: 0-3 (page orientation in multiples of 90 degrees)
     *   rotate: degrees to rotate clockwise to correct (0, 90, 180, 270)
     *   orientationConfidence: confidence score
     */
    detect: async (image) => {
      const imageData = await loadImage(image);

      const result = await sendMessage('recognize', {
        image: imageData,
        options: {},
        output: { blocks: false, text: false, hocr: false, tsv: false }
      });

      // Tesseract returns orientation as 0-3 (multiples of 90 degrees counter-clockwise)
      // We convert to clockwise rotation needed to correct
      const orientation = result.orientation || 0;
      const rotateMap = { 0: 0, 1: 270, 2: 180, 3: 90 };

      return {
        orientation,
        rotate: rotateMap[orientation] || 0,
        orientationConfidence: result.orientation_confidence || 0
      };
    },

    terminate: async () => {
      await sendMessage('terminate', {});
      worker.terminate();
    }
  };
}

export default { createOfflineWorker, createOsdWorker };
