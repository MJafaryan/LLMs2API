/**
 * Gemini API Server - Stateless with Parallel Support
 * OpenAI-compatible endpoint for Google Gemini chat
 * Each request = new Gemini chat (no session/context)
 * 
 * Models: gemini-3, gemini-rapide, gemini-raisonnement, gemini-pro
 * Image generation: Nano Banana (normal) for Gemini 3/Rapide, Nano Banana Pro for Pro
 */

import http from 'http';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// ==================== Configuration ====================
const PORT = process.env.PORT || 3004;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'sk-gemini';
const TARGET_URL = 'https://gemini.google.com/app';
const HEADLESS = process.env.HEADLESS === 'true';
const STATE_FILE = path.join(process.cwd(), 'browser-state.json');
const MAX_PAGES = parseInt(process.env.MAX_PAGES) || 10;
const PAGE_IDLE_TIMEOUT = 60 * 1000;

// ==================== Globals ====================
let browser = null;
let context = null;
let pagePool = []; // { page, busy, id, lastUsed }
let pageIdCounter = 0;
let isInitializing = false;

// ==================== Logger ====================
function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : '';
  console.log(`${ts} [${level}] ${msg}${metaStr}`);
}

// ==================== Browser Utils ====================
function sleep(min, max = min) {
  const ms = max > min ? Math.floor(Math.random() * (max - min) + min) : min;
  return new Promise(r => setTimeout(r, ms));
}

// ==================== Browser Init ====================
async function initBrowser() {
  if (browser || isInitializing) return;
  isInitializing = true;
  
  log('INFO', 'Starting browser...');
  browser = await chromium.launch({ 
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled']
  });
  
  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  
  if (fs.existsSync(STATE_FILE)) {
    log('INFO', 'Loading saved browser state...');
    contextOptions.storageState = STATE_FILE;
  }

  context = await browser.newContext(contextOptions);
  
  // Create initial page
  const initialPage = await createNewPage();
  log('INFO', 'Navigating to Gemini...');
  await initialPage.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(3000, 5000);
  initialPage.busy = false;
  initialPage.lastUsed = Date.now();
  
  // Start cleanup intervals
  setInterval(cleanupIdlePages, 30000);
  setInterval(saveState, 30000);
  isInitializing = false;
  
  log('INFO', `Browser ready. Pages will be created on demand (max: ${MAX_PAGES})`);
}

async function createNewPage() {
  const page = await context.newPage();
  
  // Prevent page from being closed by the website
  page.on('close', () => {
    log('WARN', `Page closed unexpectedly, removing from pool`);
    pagePool = pagePool.filter(p => p.page !== page);
  });
  
  const pageObj = { 
    page, 
    busy: true, 
    id: pageIdCounter++, 
    lastUsed: Date.now() 
  };
  pagePool.push(pageObj);
  log('INFO', `Created new page ${pageObj.id} (total: ${pagePool.length})`);
  return pageObj;
}

// Check if page is still valid/open
async function isPageValid(pageObj) {
  try {
    // Try to access the page - if closed, this will throw
    await pageObj.page.evaluate(() => true);
    return true;
  } catch (e) {
    return false;
  }
}

async function cleanupIdlePages() {
  const now = Date.now();
  const toRemove = [];
  const minPages = 1;
  
  for (const p of pagePool) {
    // Check if page is still valid
    const valid = await isPageValid(p);
    if (!valid) {
      toRemove.push(p);
      log('WARN', `Page ${p.id} is no longer valid, marking for removal`);
      continue;
    }
    
    // Check if page is idle and can be removed
    if (!p.busy && pagePool.length > minPages && (now - p.lastUsed) > PAGE_IDLE_TIMEOUT) {
      if (pagePool.length - toRemove.length > minPages) {
        toRemove.push(p);
      }
    }
  }
  
  for (const p of toRemove) {
    if (pagePool.length <= minPages) break;
    try {
      // Only try to close if page is still valid
      if (await isPageValid(p)) {
        await p.page.close();
      }
      pagePool = pagePool.filter(x => x.id !== p.id);
      log('INFO', `Removed page ${p.id} (remaining: ${pagePool.length})`);
    } catch (e) {
      // Page already closed, just remove from pool
      pagePool = pagePool.filter(x => x.id !== p.id);
      log('WARN', `Page ${p.id} cleanup error, removed from pool`, { error: e.message });
    }
  }
  
  // Ensure we always have at least one page
  if (pagePool.length === 0) {
    log('INFO', 'No pages in pool, creating initial page');
    const newPage = await createNewPage();
    await newPage.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    newPage.busy = false;
    newPage.lastUsed = Date.now();
  }
}

async function saveState() {
  if (!context) return;
  try {
    await context.storageState({ path: STATE_FILE });
  } catch (e) {
    log('WARN', 'Failed to save state', { error: e.message });
  }
}

async function getAvailablePage() {
  // First, clean up any closed pages
  const validPages = [];
  for (const p of pagePool) {
    if (await isPageValid(p)) {
      validPages.push(p);
    } else {
      log('WARN', `Removing invalid/closed page ${p.id} from pool`);
    }
  }
  pagePool = validPages;
  
  // Find an available page
  for (const p of pagePool) {
    if (!p.busy) {
      p.busy = true;
      p.lastUsed = Date.now();
      log('INFO', `Reusing page ${p.id}`);
      return p;
    }
  }
  
  // Create new page if under limit
  if (pagePool.length < MAX_PAGES) {
    return await createNewPage();
  }
  
  log('INFO', `All ${MAX_PAGES} pages busy, waiting...`);
  return new Promise((resolve) => {
    const check = setInterval(async () => {
      for (const p of pagePool) {
        if (!p.busy && await isPageValid(p)) {
          p.busy = true;
          p.lastUsed = Date.now();
          clearInterval(check);
          log('INFO', `Page ${p.id} became available`);
          resolve(p);
          return;
        }
      }
      
      // If all pages are invalid/closed, create a new one
      const validCount = (await Promise.all(pagePool.map(p => isPageValid(p)))).filter(Boolean).length;
      if (validCount === 0 && pagePool.length > 0) {
        clearInterval(check);
        log('WARN', 'All pages closed, creating new one');
        pagePool = [];
        resolve(await createNewPage());
      }
    }, 100);
  });
}

function releasePage(pageObj) {
  pageObj.busy = false;
  pageObj.lastUsed = Date.now();
}

// ==================== Model Selection ====================
async function selectModel(page, modelId) {
  try {
    // Model mapping: API model ID -> UI text (French)
    // Rapide = Gemini 3 Preview, Raisonnement = Gemini 3 Reasoning, Pro = Gemini 3 Pro
    const modelMap = {
      'gemini-preview': 'Rapide',
      'gemini-reasoning': 'Raisonnement',
      'gemini-pro': 'Pro'
    };
    
    const baseModel = modelId.replace(/-image$/g, '');
    const targetModel = modelMap[baseModel] || 'Rapide';
    
    // Click on model selector dropdown
    const modelSelector = await page.$('button:has-text("Rapide"), button:has-text("Raisonnement"), button:has-text("Pro"), [class*="model-selector"]');
    if (modelSelector) {
      await modelSelector.click();
      await sleep(500, 800);
      
      // Click on the target model option
      const modelOption = await page.$(`text="${targetModel}"`);
      if (modelOption) {
        await modelOption.click();
        await sleep(500, 800);
        log('INFO', `Selected model: ${targetModel}`);
        return true;
      }
      
      // Try partial match
      const options = await page.$$('[role="option"], [role="menuitem"], [class*="option"]');
      for (const opt of options) {
        const text = await opt.textContent();
        if (text?.includes(targetModel)) {
          await opt.click();
          await sleep(500, 800);
          log('INFO', `Selected model via partial match: ${targetModel}`);
          return true;
        }
      }
    }
    
    log('WARN', `Could not find model selector for: ${targetModel}`);
    return false;
  } catch (e) {
    log('WARN', 'Could not select model', { error: e.message });
    return false;
  }
}

// ==================== Image Generation Mode ====================
async function enableImageGeneration(page) {
  try {
    // Click on "Outils" button to open tools menu
    const outilsBtn = await page.$('button:has-text("Outils"), [aria-label*="Outils"]');
    if (outilsBtn) {
      await outilsBtn.click();
      await sleep(500, 800);
      
      // Click on "Créer des images" option
      const imageOption = await page.$('text="Créer des images"');
      if (imageOption) {
        await imageOption.click();
        await sleep(500, 800);
        log('INFO', 'Enabled image generation mode');
        return true;
      }
    }
    
    // Alternative: try clicking directly on "Créer une image" chip if visible
    const imageChip = await page.$('text="Créer une image"');
    if (imageChip) {
      await imageChip.click();
      await sleep(500, 800);
      log('INFO', 'Clicked image generation chip');
      return true;
    }
    
    return false;
  } catch (e) {
    log('WARN', 'Could not enable image generation', { error: e.message });
    return false;
  }
}

// ==================== Gemini Generate ====================
async function generate(prompt, modelId = 'gemini-preview', onChunk = null) {
  if (!pagePool.length) throw new Error('Browser not initialized');
  
  const isStreaming = typeof onChunk === 'function';
  // Check if it's an image generation model (nano-banana or nano-banana-pro)
  const isImageGen = modelId.startsWith('nano-banana');
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  // Map nano-banana models to their base Gemini models
  let baseModel = modelId;
  if (modelId === 'nano-banana') {
    baseModel = 'gemini-preview';
  } else if (modelId === 'nano-banana-pro') {
    baseModel = 'gemini-pro';
  }
  
  const pageObj = await getAvailablePage();
  const page = pageObj.page;
  
  log('INFO', `Starting generation on page ${pageObj.id}...`, { 
    model: modelId, 
    streaming: isStreaming,
    imageGen: isImageGen,
    requestId
  });
  
  try {
    // Navigate to fresh chat
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(2000, 3000);
    
    // Inject interceptors for response capture (XHR-based for Gemini)
    await page.evaluate((reqId) => {
      if (!window.__geminiRequests) {
        window.__geminiRequests = {};
      }
      
      window.__geminiRequests[reqId] = {
        chunks: [],
        latestText: '',
        complete: false,
        error: null,
        active: true,
        debug: [],
        lastProcessedLength: 0
      };
      
      // Helper to parse Gemini's streaming response format
      // Based on intercepted data: response text is in nested arrays like:
      // [["wrb.fr",null,"[null,[...],null,null,[[\"rc_xxx\",[\"Hello again!...\"],...]]]"]]
      const parseGeminiResponse = (text, req) => {
        try {
          // Split by line-length prefixes (Gemini format: "123[..." where 123 is length)
          const chunks = text.split(/\n(?=\d+\[)/);
          
          for (const chunk of chunks) {
            // Remove length prefix and )]}' if present
            let cleanChunk = chunk.replace(/^\d+/, '').trim();
            if (cleanChunk.includes(")]}'")) {
              cleanChunk = cleanChunk.split(")]}'").pop();
            }
            
            if (!cleanChunk.startsWith('[')) continue;
            
            try {
              const outer = JSON.parse(cleanChunk);
              if (!Array.isArray(outer)) continue;
              
              // Look for wrb.fr entries
              for (const entry of outer) {
                if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
                
                // entry[2] contains the JSON string with response data
                const innerJson = entry[2];
                if (typeof innerJson !== 'string') continue;
                
                try {
                  const innerData = JSON.parse(innerJson);
                  if (!Array.isArray(innerData)) continue;
                  
                  // Structure: [null, [convId, respId], null, null, [[rc_id, [TEXT], ...]]]
                  // The text is at innerData[4][0][1][0]
                  const responseBlock = innerData[4];
                  if (Array.isArray(responseBlock) && responseBlock[0]) {
                    const textArray = responseBlock[0][1];
                    if (Array.isArray(textArray) && textArray[0]) {
                      const responseText = textArray[0];
                      if (typeof responseText === 'string' && responseText.length > 0) {
                        // Decode escape sequences
                        const decoded = responseText
                          .replace(/\\n/g, '\n')
                          .replace(/\\t/g, '\t')
                          .replace(/\\"/g, '"')
                          .replace(/\\\\/g, '\\');
                        
                        // Store the latest full response (Gemini sends cumulative text)
                        req.latestText = decoded;
                      }
                    }
                  }
                } catch {}
              }
            } catch {}
          }
          
          // Fallback: regex pattern for rc_ response blocks
          // Pattern: ["rc_xxx",["text content here"],...]
          // Use a more robust pattern that handles escaped characters
          // Look for the full text block, not just the first match
          const rcPattern = /\["rc_[a-f0-9]+",\s*\["((?:[^"\\]|\\.)*)"/g;
          let match;
          let longestContent = req.latestText || '';
          while ((match = rcPattern.exec(text)) !== null) {
            try {
              const content = match[1]
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
                .replace(/\\u003c/g, '<')
                .replace(/\\u003e/g, '>')
                .replace(/\\u0026/g, '&')
                .replace(/\\u0027/g, "'");
              // Keep the longest content found
              if (content.length > longestContent.length) {
                longestContent = content;
              }
            } catch {}
          }
          if (longestContent.length > (req.latestText?.length || 0)) {
            req.latestText = longestContent;
          }
          
        } catch (e) {
          req.debug.push(`Parse error: ${e.message}`);
        }
      };
      
      if (!window.__geminiIntercepted) {
        window.__geminiIntercepted = true;
        
        // Intercept XMLHttpRequest (Gemini uses XHR for streaming)
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;
        
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this._url = url;
          this._method = method;
          return originalXHROpen.call(this, method, url, ...rest);
        };
        
        XMLHttpRequest.prototype.send = function(body) {
          const url = this._url || '';
          
          const activeReqId = Object.keys(window.__geminiRequests || {})
            .find(id => window.__geminiRequests[id]?.active);
          
          if (activeReqId && window.__geminiRequests[activeReqId]) {
            window.__geminiRequests[activeReqId].debug.push(`XHR: ${url.substring(0, 80)}`);
          }
          
          // Intercept StreamGenerate endpoint (main response stream)
          if (url.includes('StreamGenerate')) {
            if (activeReqId) {
              const req = window.__geminiRequests[activeReqId];
              
              // Listen for progress events (streaming)
              this.addEventListener('progress', () => {
                const newText = this.responseText.substring(req.lastProcessedLength);
                req.lastProcessedLength = this.responseText.length;
                if (newText) {
                  parseGeminiResponse(newText, req);
                }
              });
              
              // Listen for completion - only mark complete for StreamGenerate
              this.addEventListener('load', () => {
                const newText = this.responseText.substring(req.lastProcessedLength);
                if (newText) {
                  parseGeminiResponse(newText, req);
                }
                // Wait a bit before marking complete to ensure all text is captured
                // Gemini may still be processing the response
                setTimeout(() => {
                  if (req.latestText && req.latestText.length > 10) {
                    req.complete = true;
                  }
                }, 2000);
              });
              
              this.addEventListener('error', () => {
                req.error = 'XHR error';
                req.complete = true;
              });
            }
          }
          // Also parse batchexecute responses for text content
          else if (url.includes('batchexecute') && url.includes('BardChatUi')) {
            if (activeReqId) {
              const req = window.__geminiRequests[activeReqId];
              
              this.addEventListener('load', () => {
                parseGeminiResponse(this.responseText, req);
              });
            }
          }
          
          return originalXHRSend.call(this, body);
        };
        
        // Also intercept fetch - Gemini may use fetch for streaming
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const response = await originalFetch.apply(this, args);
          const url = args[0]?.toString?.() || args[0]?.url || '';
          
          const activeReqId = Object.keys(window.__geminiRequests || {})
            .find(id => window.__geminiRequests[id]?.active);
          
          if (activeReqId && window.__geminiRequests[activeReqId]) {
            window.__geminiRequests[activeReqId].debug.push(`fetch: ${url.substring(0, 80)}`);
          }
          
          // Intercept StreamGenerate via fetch as well
          if (url.includes('StreamGenerate') || url.includes('batchexecute')) {
            const clone = response.clone();
            const reader = clone.body?.getReader();
            
            if (reader && activeReqId) {
              const req = window.__geminiRequests[activeReqId];
              const decoder = new TextDecoder();
              
              (async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                      // Wait before marking complete
                      setTimeout(() => {
                        if (req.latestText && req.latestText.length > 10) {
                          req.complete = true;
                        }
                      }, 2000);
                      break;
                    }
                    const text = decoder.decode(value, { stream: true });
                    parseGeminiResponse(text, req);
                  }
                } catch (e) {
                  req.error = e.message;
                  req.complete = true;
                }
              })();
            }
          }
          
          return response;
        };
      }
    }, requestId);
    
    // Wait for input area
    await page.waitForSelector('textarea, [contenteditable="true"], [role="textbox"]', { timeout: 60000 });
    await sleep(500, 1000);
    
    // Select model
    // For image generation: nano-banana uses Preview, nano-banana-pro uses Pro
    await selectModel(page, baseModel);
    
    // Enable image generation if requested
    // nano-banana = Nano Banana, nano-banana-pro = Nano Banana Pro
    if (isImageGen) {
      await enableImageGeneration(page);
      await sleep(500, 800);
    }
    
    // Find and click the input area
    let inputArea = await page.$('textarea[placeholder*="prompt"], textarea[placeholder*="Gemini"]');
    if (!inputArea) {
      inputArea = await page.$('textarea');
    }
    if (!inputArea) {
      inputArea = await page.$('[contenteditable="true"]');
    }
    if (!inputArea) {
      inputArea = await page.$('[role="textbox"]');
    }
    
    if (!inputArea) {
      throw new Error('Could not find input area');
    }
    
    await inputArea.click();
    await sleep(300, 500);
    
    // Type the prompt
    await page.keyboard.type(prompt, { delay: 5 });
    await sleep(500, 1000);
    
    // Send message - try Enter or find send button
    const sendButton = await page.$('[aria-label*="Envoyer"], [aria-label*="Send"], button[type="submit"]');
    if (sendButton) {
      await sendButton.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    log('INFO', 'Message sent, waiting for response...');

    if (isImageGen) {
      // For image generation, wait for image to appear
      log('INFO', 'Waiting for image generation (Nano Banana)...');
      
      let imageUrl = null;
      const startTime = Date.now();
      const timeout = 300000; // 5 minutes
      
      await sleep(10000); // Initial wait for generation
      
      while (Date.now() - startTime < timeout) {
        await sleep(2000);
        
        // Look for generated images in the response
        imageUrl = await page.evaluate(() => {
          // Look for images in the response area
          const responseArea = document.querySelector('[class*="response"], [class*="message"], [class*="answer"]');
          if (responseArea) {
            const images = responseArea.querySelectorAll('img');
            for (const img of images) {
              const src = img.src || '';
              // Filter out UI icons, look for generated content
              if (src.includes('googleusercontent') || src.includes('generated') || 
                  (src.startsWith('http') && img.width > 100)) {
                return src;
              }
            }
          }
          
          // Fallback: look for any large images
          const allImages = document.querySelectorAll('img');
          for (const img of allImages) {
            const src = img.src || '';
            if (src.includes('googleusercontent') && img.width > 100) {
              return src;
            }
          }
          return null;
        });
        
        if (imageUrl) {
          log('INFO', `Image generated: ${imageUrl.substring(0, 100)}...`);
          break;
        }
        
        // Check for error messages
        const errorMsg = await page.evaluate(() => {
          const errors = document.querySelectorAll('[class*="error"], [class*="Error"]');
          for (const el of errors) {
            if (el.textContent?.trim()) return el.textContent.trim();
          }
          return null;
        });
        
        if (errorMsg) {
          throw new Error(`Image generation failed: ${errorMsg}`);
        }
      }
      
      if (!imageUrl) {
        throw new Error('Image generation timeout - no image found');
      }
      
      // Google's gg-dl URLs are session-protected
      // Use Playwright to capture the image
      log('INFO', 'Capturing image via screenshot...');
      
      let imageData = null;
      
      // Wait for image to fully render
      await sleep(5000);
      
      // Method 1: Use Playwright's request context to download the image directly
      try {
        // Modify URL to get higher resolution if possible (remove size constraints)
        let highResUrl = imageUrl;
        if (highResUrl.includes('=s')) {
          // Replace size parameter with larger size
          highResUrl = highResUrl.replace(/=s\d+-/, '=s1024-').replace(/=s\d+$/, '=s1024');
        }
        
        const response = await page.context().request.get(highResUrl);
        if (response.ok()) {
          const buffer = await response.body();
          const base64 = buffer.toString('base64');
          const contentType = response.headers()['content-type'] || 'image/png';
          imageData = {
            base64,
            mimeType: contentType,
            size: buffer.length
          };
          log('INFO', `Image downloaded via context: ${buffer.length} bytes, ${contentType}`);
        }
      } catch (e) {
        log('WARN', `Context download failed: ${e.message}`);
      }
      
      // Method 2: If context download failed, use screenshot
      if (!imageData) {
        log('INFO', 'Trying screenshot method...');
        try {
          const imgElement = await page.$(`img[src*="googleusercontent"], img[src*="ggpht"]`);
          if (imgElement) {
            const box = await imgElement.boundingBox();
            if (box && box.width > 100 && box.height > 100) {
              const screenshotBuffer = await imgElement.screenshot({ 
                type: 'png',
                omitBackground: true
              });
              const base64 = screenshotBuffer.toString('base64');
              imageData = {
                base64,
                mimeType: 'image/png',
                size: screenshotBuffer.length
              };
              log('INFO', `Screenshot captured: ${box.width}x${box.height}, ${screenshotBuffer.length} bytes`);
            }
          }
        } catch (e) {
          log('WARN', `Screenshot method failed: ${e.message}`);
        }
      }
      
      let fullResponse;
      if (!imageData || !imageData.base64) {
        log('WARN', 'All download methods failed, returning URL');
        fullResponse = `![Generated Image](${imageUrl})`;
      } else {
        log('INFO', `Image captured: ${imageData.size} bytes`);
        fullResponse = `![Generated Image](data:${imageData.mimeType};base64,${imageData.base64})`;
      }
      
      if (isStreaming && onChunk) {
        onChunk(fullResponse);
      }
      
      // Cleanup request
      await page.evaluate((reqId) => {
        if (window.__geminiRequests?.[reqId]) {
          window.__geminiRequests[reqId].active = false;
          setTimeout(() => {
            delete window.__geminiRequests[reqId];
          }, 5000);
        }
      }, requestId);
      
      log('INFO', `Page ${pageObj.id} generated image`);
      return { imageUrl, imageData };
      
    } else {
      // Text generation - poll for response
      let fullResponse = '';
      let lastTextLength = 0;
      let stableCount = 0;
      const startTime = Date.now();
      const timeout = 300000; // 5 minutes
      
      while (Date.now() - startTime < timeout) {
        await sleep(100);
        
        const result = await page.evaluate((reqId) => {
          const req = window.__geminiRequests?.[reqId];
          if (!req) return { latestText: '', complete: false, error: 'Request not found', debug: [] };
          return {
            latestText: req.latestText || '',
            complete: req.complete || false,
            error: req.error,
            debug: req.debug || []
          };
        }, requestId);
        
        // Log debug info periodically
        if (stableCount === 0 && result.debug?.length > 0) {
          log('DEBUG', 'Intercepted URLs', { urls: result.debug.slice(-5) });
        }
        
        if (result.error && result.error !== 'Request not found') {
          log('WARN', 'Stream error', { error: result.error });
        }
        
        // Check for new text (Gemini sends cumulative text, so we track the delta)
        if (result.latestText.length > lastTextLength) {
          const newContent = result.latestText.substring(lastTextLength);
          fullResponse = result.latestText; // Use full cumulative text
          
          if (isStreaming && onChunk) {
            onChunk(newContent);
          }
          lastTextLength = result.latestText.length;
          stableCount = 0;
        } else if (fullResponse.length > 0) {
          stableCount++;
        }
        
        // Check if complete - but wait a bit more to ensure all text is captured
        if (result.complete && fullResponse.length > 0) {
          // Wait for 20 more iterations (2 seconds) after complete to catch any final text
          if (stableCount >= 20) {
            log('INFO', 'Stream complete');
            break;
          }
        }
        
        // Fallback: timeout if stable for 30 seconds
        if (stableCount > 300 && fullResponse.length > 0) {
          log('INFO', 'Response stable for 30s, assuming complete');
          break;
        }
      }
      
      // If no SSE chunks captured, try to get response from DOM
      if (!fullResponse?.trim()) {
        log('INFO', 'No stream chunks, trying DOM extraction...');
        await sleep(3000);
        
        fullResponse = await page.evaluate(() => {
          // Gemini-specific selectors for response content
          const selectors = [
            // Model response containers
            'message-content[class*="model"]',
            '[data-message-author-role="model"]',
            '.model-response-text',
            // Markdown rendered content
            '.markdown-main-panel',
            '.response-container-content',
            // Generic message containers
            '[class*="response-content"]',
            '[class*="message-content"]',
            // Code blocks and text
            '.code-block',
            'pre code',
            // Fallback: any large text block in conversation
            '.conversation-container [class*="text"]'
          ];
          
          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
              const lastEl = elements[elements.length - 1];
              const text = lastEl.innerText?.trim() || lastEl.textContent?.trim();
              if (text && text.length > 20) {
                return text;
              }
            }
          }
          
          // Fallback: find the last large text block that looks like a response
          const allDivs = document.querySelectorAll('div');
          let bestMatch = '';
          for (const div of allDivs) {
            const text = div.innerText?.trim();
            // Look for substantial text that's not UI elements
            if (text && text.length > 100 && text.length < 50000) {
              // Skip if it contains too many UI-like patterns
              if (!text.includes('Outils') && 
                  !text.includes('Rapide') && 
                  !text.includes('Gemini 3') &&
                  text.split('\n').length > 1) {
                if (text.length > bestMatch.length) {
                  bestMatch = text;
                }
              }
            }
          }
          
          return bestMatch;
        });
      }
      
      // Cleanup request
      await page.evaluate((reqId) => {
        if (window.__geminiRequests?.[reqId]) {
          window.__geminiRequests[reqId].active = false;
          setTimeout(() => {
            delete window.__geminiRequests[reqId];
          }, 5000);
        }
      }, requestId);
      
      if (!fullResponse?.trim()) {
        throw new Error('Empty response - no content received');
      }
      
      log('INFO', `Page ${pageObj.id} generated ${fullResponse.length} chars`);
      return fullResponse.trim();
    }
    
  } finally {
    releasePage(pageObj);
  }
}

// ==================== HTTP Server ====================
const MODELS = [
  { id: 'gemini-preview', name: 'Gemini 3 Preview (Rapide)' },
  { id: 'gemini-reasoning', name: 'Gemini 3 Reasoning (Raisonnement)' },
  { id: 'gemini-pro', name: 'Gemini 3 Pro' },
  { id: 'nano-banana', name: 'Nano Banana (Gemini 3 Preview + Image)' },
  { id: 'nano-banana-pro', name: 'Nano Banana Pro (Gemini 3 Pro + Image)' },
];

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const token = auth.replace('Bearer ', '');
  return token === AUTH_TOKEN;
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Health check
  if (pathname === '/health') {
    return sendJson(res, 200, { 
      status: 'ok', 
      browser: !!browser,
      totalPages: pagePool.length,
      busyPages: pagePool.filter(p => p.busy).length,
      maxPages: MAX_PAGES
    });
  }

  // Models list
  if (pathname === '/v1/models' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    return sendJson(res, 200, {
      object: 'list',
      data: MODELS.map(m => ({
        id: m.id,
        object: 'model',
        created: Date.now(),
        owned_by: 'google'
      }))
    });
  }

  // Chat completions
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    try {
      const body = await parseBody(req);
      const { model = 'gemini-rapide', messages = [], stream = false } = body;
      
      if (!messages.length) {
        return sendJson(res, 400, { error: 'No messages provided' });
      }

      const lastUserMsg = messages.filter(m => m.role === 'user').pop();
      if (!lastUserMsg) {
        return sendJson(res, 400, { error: 'No user message found' });
      }
      
      const prompt = typeof lastUserMsg.content === 'string' 
        ? lastUserMsg.content 
        : lastUserMsg.content.map(c => c.text || '').join('\n');

      const responseId = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        const onChunk = (chunk) => {
          const chunkData = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        };

        try {
          await generate(prompt, model, onChunk);
          
          const finishData = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }]
          };
          res.write(`data: ${JSON.stringify(finishData)}\n\n`);
          res.write('data: [DONE]\n\n');
          
        } catch (e) {
          res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        }
        
        return res.end();
        
      } else {
        const result = await generate(prompt, model);
        
        // Handle image generation response (returns object with imageUrl and imageData)
        let content;
        if (typeof result === 'object' && result.imageData) {
          if (result.imageData.base64) {
            content = `![Generated Image](data:${result.imageData.mimeType};base64,${result.imageData.base64})`;
          } else {
            content = `![Generated Image](${result.imageUrl})`;
          }
        } else {
          content = result;
        }

        return sendJson(res, 200, {
          id: responseId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }

    } catch (e) {
      log('ERROR', 'Generation failed', { error: e.message });
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Image generations endpoint (OpenAI-compatible)
  if (pathname === '/v1/images/generations' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    try {
      const body = await parseBody(req);
      const { prompt, model = 'nano-banana', n = 1, size = '1024x1024' } = body;
      
      if (!prompt) {
        return sendJson(res, 400, { error: 'No prompt provided' });
      }

      // Determine which Nano Banana to use based on model
      let imageModel = model;
      if (!model.startsWith('nano-banana')) {
        // Default: use nano-banana, or nano-banana-pro if pro model specified
        imageModel = model.includes('pro') ? 'nano-banana-pro' : 'nano-banana';
      }
      
      const nanoBananaType = imageModel.includes('pro') ? 'Nano Banana Pro' : 'Nano Banana';
      log('INFO', 'Image generation request', { prompt: prompt.substring(0, 50), model: imageModel, nanoBanana: nanoBananaType });

      const result = await generate(prompt, imageModel);
      
      // Handle new response format with imageUrl and imageData
      let responseData;
      if (typeof result === 'object' && result.imageData) {
        if (result.imageData.base64) {
          // Return base64 data URL
          responseData = {
            url: result.imageUrl, // Original URL (may not work externally)
            b64_json: result.imageData.base64,
            revised_prompt: prompt
          };
        } else {
          responseData = {
            url: result.imageUrl,
            revised_prompt: prompt
          };
        }
      } else {
        // Legacy format - extract URL from markdown
        const urlMatch = result.match(/!\[.*?\]\((.*?)\)/);
        const imageUrl = urlMatch ? urlMatch[1] : result;
        responseData = {
          url: imageUrl,
          revised_prompt: prompt
        };
      }

      return sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [responseData]
      });

    } catch (e) {
      log('ERROR', 'Image generation failed', { error: e.message });
      return sendJson(res, 500, { error: e.message });
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ==================== Main ====================
async function main() {
  await initBrowser();
  
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    log('INFO', `Gemini Server running on port ${PORT}`);
    log('INFO', `API Key: ${AUTH_TOKEN}`);
    log('INFO', 'Endpoints:');
    log('INFO', '  GET  /health               - Health check');
    log('INFO', '  GET  /v1/models            - List models');
    log('INFO', '  POST /v1/chat/completions  - Chat (stateless, each request = new chat)');
    log('INFO', '  POST /v1/images/generations - Image generation (Nano Banana)');
    log('INFO', '');
    log('INFO', 'Models:');
    log('INFO', '  gemini-preview (Rapide), gemini-reasoning (Raisonnement), gemini-pro (Pro)');
    log('INFO', '  nano-banana (Preview + Image), nano-banana-pro (Pro + Image)');
  });

  process.on('SIGINT', async () => {
    log('INFO', 'Shutting down...');
    if (context) await saveState();
    if (browser) await browser.close();
    process.exit(0);
  });
}

main().catch(e => {
  log('ERROR', 'Startup failed', { error: e.message });
  process.exit(1);
});
