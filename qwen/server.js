/**
 * Qwen API Server - Stateless with Parallel Support
 * OpenAI-compatible endpoint for Qwen chat
 * Each request = new Qwen chat (no session/context)
 */

import http from 'http';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// ==================== Configuration ====================
const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'sk-qwen';
const TARGET_URL = 'https://chat.qwen.ai/';
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
  log('INFO', 'Navigating to Qwen...');
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

async function cleanupIdlePages() {
  const now = Date.now();
  const toRemove = [];
  const minPages = 1;
  
  for (const p of pagePool) {
    if (!p.busy && pagePool.length > minPages && (now - p.lastUsed) > PAGE_IDLE_TIMEOUT) {
      if (pagePool.length - toRemove.length > minPages) {
        toRemove.push(p);
      }
    }
  }
  
  for (const p of toRemove) {
    if (pagePool.length <= minPages) break;
    try {
      await p.page.close();
      pagePool = pagePool.filter(x => x.id !== p.id);
      log('INFO', `Closed idle page ${p.id} (remaining: ${pagePool.length})`);
    } catch (e) {
      log('WARN', `Failed to close page ${p.id}`, { error: e.message });
    }
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
  for (const p of pagePool) {
    if (!p.busy) {
      p.busy = true;
      p.lastUsed = Date.now();
      log('INFO', `Reusing page ${p.id}`);
      return p;
    }
  }
  
  if (pagePool.length < MAX_PAGES) {
    return await createNewPage();
  }
  
  log('INFO', `All ${MAX_PAGES} pages busy, waiting...`);
  return new Promise((resolve) => {
    const check = setInterval(() => {
      for (const p of pagePool) {
        if (!p.busy) {
          p.busy = true;
          p.lastUsed = Date.now();
          clearInterval(check);
          log('INFO', `Page ${p.id} became available`);
          resolve(p);
          return;
        }
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
    const baseModel = modelId.replace(/-thinking/g, '').replace(/-search/g, '');
    
    const modelMap = {
      'qwen3-max': 'Qwen3-Max',
      'qwen3-vl-235b': 'Qwen3-VL-235B-A22B',
      'qwen3-coder': 'Qwen3-Coder',
      'qwen3-vl-32b': 'Qwen3-VL-32B'
    };
    
    const targetModel = modelMap[baseModel] || 'Qwen3-Max';
    
    const modelSelector = await page.$('[class*="model-select"], [class*="model-picker"], button:has-text("Qwen3")');
    if (modelSelector) {
      await modelSelector.click();
      await sleep(500, 800);
      
      const modelOption = await page.$(`text=${targetModel}`);
      if (modelOption) {
        await modelOption.click();
        await sleep(500, 800);
        log('INFO', `Selected model: ${targetModel}`);
        return true;
      }
    }
    return false;
  } catch (e) {
    log('WARN', 'Could not select model', { error: e.message });
    return false;
  }
}

// ==================== Toggle Buttons ====================
async function toggleButton(page, buttonName, targetState) {
  try {
    const btn = page.getByRole('button', { name: buttonName });
    const btnCount = await btn.count();
    if (btnCount === 0) return false;

    const isSelected = await btn.evaluate(el => {
      return el.classList.contains('selected') || 
             el.classList.contains('active') ||
             el.getAttribute('aria-pressed') === 'true' ||
             el.querySelector('.selected, .active') !== null;
    });
    
    if (isSelected !== targetState) {
      await btn.click();
      await sleep(300, 500);
      log('INFO', `Toggled ${buttonName} to ${targetState}`);
    }
    return true;
  } catch {
    return false;
  }
}

// ==================== Qwen Generate ====================
async function generate(prompt, modelId = 'qwen3-max', onChunk = null) {
  if (!pagePool.length) throw new Error('Browser not initialized');
  
  const isStreaming = typeof onChunk === 'function';
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  const pageObj = await getAvailablePage();
  const page = pageObj.page;
  
  log('INFO', `Starting generation on page ${pageObj.id}...`, { 
    model: modelId, 
    streaming: isStreaming,
    requestId
  });
  
  try {
    // Navigate to fresh chat
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(2000, 3000);
    
    // Inject fetch interceptor
    await page.evaluate((reqId) => {
      if (!window.__qwenRequests) {
        window.__qwenRequests = {};
      }
      
      window.__qwenRequests[reqId] = {
        chunks: [],
        complete: false,
        error: null,
        active: true
      };
      
      if (!window.__qwenFetchIntercepted) {
        window.__qwenFetchIntercepted = true;
        const originalFetch = window.fetch;
        
        window.fetch = async function(...args) {
          const response = await originalFetch.apply(this, args);
          const url = args[0]?.toString?.() || args[0]?.url || '';
          
          if (url.includes('/api/') && url.includes('chat')) {
            const clone = response.clone();
            const reader = clone.body?.getReader();
            
            if (reader) {
              const decoder = new TextDecoder();
              const activeReqId = Object.keys(window.__qwenRequests || {})
                .find(id => window.__qwenRequests[id]?.active);
              
              if (activeReqId) {
                (async () => {
                  try {
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) {
                        if (window.__qwenRequests[activeReqId]) {
                          window.__qwenRequests[activeReqId].complete = true;
                        }
                        break;
                      }
                      
                      const text = decoder.decode(value, { stream: true });
                      const lines = text.split('\n');
                      
                      for (const line of lines) {
                        if (!line.startsWith('data:')) continue;
                        const dataStr = line.slice(5).trim();
                        if (!dataStr || dataStr === '[DONE]') {
                          if (window.__qwenRequests[activeReqId]) {
                            window.__qwenRequests[activeReqId].complete = true;
                          }
                          continue;
                        }
                        
                        try {
                          const data = JSON.parse(dataStr);
                          if (data.choices?.[0]?.delta?.content) {
                            if (window.__qwenRequests[activeReqId]) {
                              window.__qwenRequests[activeReqId].chunks.push(data.choices[0].delta.content);
                            }
                          }
                          if (data.choices?.[0]?.finish_reason === 'stop' ||
                              data.choices?.[0]?.finish_reason === 'length') {
                            if (window.__qwenRequests[activeReqId]) {
                              window.__qwenRequests[activeReqId].complete = true;
                            }
                          }
                        } catch {}
                      }
                    }
                  } catch (e) {
                    if (window.__qwenRequests[activeReqId]) {
                      window.__qwenRequests[activeReqId].error = e.message;
                      window.__qwenRequests[activeReqId].complete = true;
                    }
                  }
                })();
              }
            }
          }
          return response;
        };
      }
    }, requestId);
    
    // Wait for input
    await page.waitForSelector('textarea', { timeout: 60000 });
    await sleep(500, 1000);
    
    await selectModel(page, modelId);
    
    // Check if this is image generation mode
    const isImageGen = modelId.includes('image');
    
    if (isImageGen) {
      // Click on "Génération d'image" button
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], div[class*="chip"], span[class*="chip"]');
        for (const btn of buttons) {
          if (btn.textContent?.includes("Génération d'image")) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (clicked) {
        await sleep(800, 1200);
        log('INFO', 'Clicked image generation button');
      } else {
        try {
          await page.click('text="Génération d\'image"');
          await sleep(800, 1200);
          log('INFO', 'Clicked image generation button via text selector');
        } catch (e) {
          log('WARN', 'Could not find image generation button', { error: e.message });
        }
      }
    } else {
      // Configure thinking and search toggles
      const thinking = modelId.includes('thinking');
      const search = modelId.includes('search');
      
      if (thinking || search) {
        const thinkingClicked = await toggleButton(page, 'Pensée', thinking);
        await sleep(200, 400);
        const searchClicked = await toggleButton(page, 'Recherche', search);
        await sleep(200, 400);
        
        log('INFO', `Toggle buttons: thinking=${thinking} (clicked=${thinkingClicked}), search=${search} (clicked=${searchClicked})`);
      }
    }
    
    // Find the input textarea
    let targetTextarea = await page.$('textarea[placeholder*="Comment"], textarea[placeholder*="aider"], textarea[placeholder*="help"], textarea[placeholder*="message"]');
    
    if (!targetTextarea) {
      targetTextarea = await page.evaluateHandle(() => {
        const textareas = document.querySelectorAll('textarea');
        if (textareas.length === 0) return null;
        let bottomTextarea = null;
        let maxBottom = 0;
        for (const ta of textareas) {
          const rect = ta.getBoundingClientRect();
          if (rect.bottom > maxBottom && rect.height > 0 && rect.width > 100) {
            maxBottom = rect.bottom;
            bottomTextarea = ta;
          }
        }
        return bottomTextarea || textareas[textareas.length - 1];
      });
      targetTextarea = targetTextarea.asElement();
    }
    
    if (targetTextarea) {
      await targetTextarea.scrollIntoViewIfNeeded();
      await targetTextarea.click();
      await sleep(300, 500);
      
      // Only clear textarea for non-image modes
      if (!isImageGen) {
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Backspace');
        await sleep(100, 200);
      }
      
      await page.keyboard.type(prompt, { delay: 5 });
    } else {
      throw new Error('Could not find input textarea');
    }
    
    await sleep(200, 300);
    
    // Send message
    await page.keyboard.press('Enter');
    log('INFO', 'Message sent, polling for response...');
    
    if (isImageGen) {
      // For image generation, wait for image to appear
      log('INFO', 'Waiting for image generation...');
      
      let imageUrl = null;
      const startTime = Date.now();
      const timeout = 300000;
      
      await sleep(10000);
      
      while (Date.now() - startTime < timeout) {
        await sleep(2000);
        
        imageUrl = await page.evaluate(() => {
          const allImages = document.querySelectorAll('img');
          for (const img of allImages) {
            const src = img.src || '';
            if (src.includes('cdn.qwenlm.ai/output/')) {
              return src;
            }
          }
          return null;
        });
        
        if (imageUrl) {
          log('INFO', `Image generated: ${imageUrl.substring(0, 100)}...`);
          break;
        }
        
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
      
      const fullResponse = `![Generated Image](${imageUrl})`;
      if (isStreaming && onChunk) {
        onChunk(fullResponse);
      }
      
      log('INFO', `Page ${pageObj.id} generated image`);
      return fullResponse;
      
    } else {
      // Text generation - poll for SSE chunks
      let fullResponse = '';
      let lastChunkCount = 0;
      let stableCount = 0;
      const startTime = Date.now();
      const timeout = 300000;
      
      while (Date.now() - startTime < timeout) {
        await sleep(100);
        
        const result = await page.evaluate((reqId) => {
          const req = window.__qwenRequests?.[reqId];
          if (!req) return { chunks: [], complete: false, error: 'Request not found' };
          return {
            chunks: req.chunks || [],
            complete: req.complete || false,
            error: req.error
          };
        }, requestId);
        
        if (result.error && result.error !== 'Request not found') {
          log('WARN', 'SSE error', { error: result.error });
        }
        
        if (result.chunks.length > lastChunkCount) {
          const newChunks = result.chunks.slice(lastChunkCount);
          for (const chunk of newChunks) {
            fullResponse += chunk;
            if (isStreaming && onChunk) {
              onChunk(chunk);
            }
          }
          lastChunkCount = result.chunks.length;
          stableCount = 0;
        } else if (fullResponse.length > 0) {
          stableCount++;
        }
        
        if (result.complete && fullResponse.length > 0) {
          log('INFO', 'SSE stream complete');
          break;
        }
        
        if (stableCount > 300 && fullResponse.length > 0) {
          log('INFO', 'Response stable for 30s, assuming complete');
          break;
        }
      }
      
      // Cleanup request
      await page.evaluate((reqId) => {
        if (window.__qwenRequests?.[reqId]) {
          window.__qwenRequests[reqId].active = false;
          setTimeout(() => {
            delete window.__qwenRequests[reqId];
          }, 5000);
        }
      }, requestId);
      
      if (!fullResponse?.trim()) {
        throw new Error('Empty response - no SSE chunks received');
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
  { id: 'qwen3-max', name: 'Qwen3-Max' },
  { id: 'qwen3-max-thinking', name: 'Qwen3-Max (Thinking)' },
  { id: 'qwen3-max-search', name: 'Qwen3-Max (Search)' },
  { id: 'qwen3-max-thinking-search', name: 'Qwen3-Max (Think+Search)' },
  { id: 'qwen3-image', name: 'Qwen3 Image Generation' },
  { id: 'qwen3-coder', name: 'Qwen3-Coder' },
  { id: 'qwen3-vl-235b', name: 'Qwen3-VL-235B-A22B' },
  { id: 'qwen3-vl-32b', name: 'Qwen3-VL-32B' },
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
        owned_by: 'alibaba'
      }))
    });
  }

  // Chat completions
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    try {
      const body = await parseBody(req);
      const { model = 'qwen3-max', messages = [], stream = false } = body;
      
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
        const text = await generate(prompt, model);

        return sendJson(res, 200, {
          id: responseId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
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
      const { prompt, n = 1, size = '1024x1024' } = body;
      
      if (!prompt) {
        return sendJson(res, 400, { error: 'No prompt provided' });
      }

      log('INFO', 'Image generation request', { prompt: prompt.substring(0, 50), n, size });

      const imageResponse = await generate(prompt, 'qwen3-image');
      
      const urlMatch = imageResponse.match(/!\[.*?\]\((.*?)\)/);
      const imageUrl = urlMatch ? urlMatch[1] : imageResponse;

      return sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [{
          url: imageUrl,
          revised_prompt: prompt
        }]
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
    log('INFO', `Qwen Server running on port ${PORT}`);
    log('INFO', `API Key: ${AUTH_TOKEN}`);
    log('INFO', 'Endpoints:');
    log('INFO', '  GET  /health               - Health check');
    log('INFO', '  GET  /v1/models            - List models');
    log('INFO', '  POST /v1/chat/completions  - Chat (stateless, each request = new chat)');
    log('INFO', '  POST /v1/images/generations - Image generation');
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
