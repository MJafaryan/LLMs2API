/**
 * ChatGPT API Server - Stateless with Parallel Support
 * OpenAI-compatible endpoint for ChatGPT web interface
 * Each request = new ChatGPT chat (no session/context)
 */

import http from 'http';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// ==================== Configuration ====================
const PORT = process.env.PORT || 3003;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'sk-chatgpt';
const TARGET_URL = 'https://chatgpt.com/';
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
  log('INFO', 'Navigating to ChatGPT...');
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

// ==================== ChatGPT Generate ====================
async function generate(prompt, modelId = 'gpt-5.1', onChunk = null) {
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
    
    // Inject interceptors for SSE capture
    await page.evaluate((reqId) => {
      if (!window.__chatgptRequests) {
        window.__chatgptRequests = {};
      }
      
      window.__chatgptRequests[reqId] = {
        chunks: [],
        complete: false,
        error: null,
        active: true,
        debug: [],
        lastPartLength: 0
      };
      
      // Helper to parse ChatGPT SSE data
      const parseSSEData = (text, req) => {
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('event:')) continue;
          
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (!dataStr || dataStr === '[DONE]') {
            req.complete = true;
            continue;
          }
          
          try {
            const data = JSON.parse(dataStr);
            
            // ChatGPT delta format: {"p": "/message/content/parts/0", "o": "append", "v": "text"}
            if (data.o === 'append' && data.p?.includes('/message/content/parts') && typeof data.v === 'string') {
              req.chunks.push(data.v);
            }
            
            // Also capture direct v strings (continuation chunks)
            if (typeof data.v === 'string' && !data.p && !data.o && !data.type) {
              req.chunks.push(data.v);
            }
            
            // Check for completion
            if (data.type === 'message_stream_complete') {
              req.complete = true;
            }
            
            // Also check patch with is_complete
            if (data.o === 'patch' && Array.isArray(data.v)) {
              for (const patch of data.v) {
                if (patch.v?.is_complete === true) {
                  req.complete = true;
                }
              }
            }
          } catch {}
        }
      };
      
      if (!window.__chatgptIntercepted) {
        window.__chatgptIntercepted = true;
        
        // Intercept fetch
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const response = await originalFetch.apply(this, args);
          const url = args[0]?.toString?.() || args[0]?.url || '';
          
          const activeReqId = Object.keys(window.__chatgptRequests || {})
            .find(id => window.__chatgptRequests[id]?.active);
          
          if (activeReqId && window.__chatgptRequests[activeReqId]) {
            window.__chatgptRequests[activeReqId].debug.push(`fetch: ${url.substring(0, 80)}`);
          }
          
          // Intercept conversation endpoint
          if (url.includes('/backend-api/f/conversation') || url.includes('/backend-api/conversation')) {
            const clone = response.clone();
            const reader = clone.body?.getReader();
            
            if (reader && activeReqId) {
              const req = window.__chatgptRequests[activeReqId];
              const decoder = new TextDecoder();
              
              (async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                      req.complete = true;
                      break;
                    }
                    const text = decoder.decode(value, { stream: true });
                    parseSSEData(text, req);
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
        
        // Also intercept EventSource for some ChatGPT implementations
        const OriginalEventSource = window.EventSource;
        if (OriginalEventSource) {
          window.EventSource = function(url, config) {
            const es = new OriginalEventSource(url, config);
            
            const activeReqId = Object.keys(window.__chatgptRequests || {})
              .find(id => window.__chatgptRequests[id]?.active);
            
            if (activeReqId) {
              const req = window.__chatgptRequests[activeReqId];
              req.debug.push(`EventSource: ${url.substring(0, 80)}`);
              
              es.addEventListener('message', (event) => {
                if (event.data) {
                  parseSSEData(`data: ${event.data}`, req);
                }
              });
              
              es.addEventListener('error', () => {
                req.complete = true;
              });
            }
            
            return es;
          };
        }
      }
    }, requestId);
    
    // Wait for input area - ChatGPT uses a ProseMirror contenteditable div
    await page.waitForSelector('#prompt-textarea, .ProseMirror, [contenteditable="true"]', { timeout: 60000 });
    await sleep(500, 1000);
    
    // The input is a contenteditable DIV with id="prompt-textarea" and class="ProseMirror"
    let inputArea = await page.$('#prompt-textarea');
    if (!inputArea) {
      inputArea = await page.$('.ProseMirror');
    }
    if (!inputArea) {
      inputArea = await page.$('[contenteditable="true"]');
    }
    
    if (!inputArea) {
      throw new Error('Could not find input area');
    }
    
    await inputArea.click();
    await sleep(300, 500);
    
    // Type the prompt
    await page.keyboard.type(prompt, { delay: 5 });
    await sleep(500, 1000);
    
    // Send message - click the send button
    const sendButton = await page.$('[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="Envoyer"]');
    if (sendButton) {
      await sendButton.click();
    } else {
      // Try Enter key as fallback
      await page.keyboard.press('Enter');
    }
    
    log('INFO', 'Message sent, polling for SSE chunks...');
    
    // Poll for chunks
    let fullResponse = '';
    let lastChunkCount = 0;
    let stableCount = 0;
    const startTime = Date.now();
    const timeout = 300000; // 5 minutes
    
    while (Date.now() - startTime < timeout) {
      await sleep(100);
      
      const result = await page.evaluate((reqId) => {
        const req = window.__chatgptRequests?.[reqId];
        if (!req) return { chunks: [], complete: false, error: 'Request not found', debug: [] };
        return {
          chunks: req.chunks || [],
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
        log('WARN', 'SSE error', { error: result.error });
      }
      
      // Send new chunks
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
      
      // Check if complete
      if (result.complete && fullResponse.length > 0) {
        log('INFO', 'SSE stream complete');
        break;
      }
      
      // Fallback: timeout if stable for 30 seconds
      if (stableCount > 300 && fullResponse.length > 0) {
        log('INFO', 'Response stable for 30s, assuming complete');
        break;
      }
    }
    
    // Cleanup request
    await page.evaluate((reqId) => {
      if (window.__chatgptRequests?.[reqId]) {
        window.__chatgptRequests[reqId].active = false;
        setTimeout(() => {
          delete window.__chatgptRequests[reqId];
        }, 5000);
      }
    }, requestId);
    
    // If no SSE chunks captured, try to get response from DOM
    if (!fullResponse?.trim()) {
      log('INFO', 'No SSE chunks, trying DOM extraction...');
      await sleep(3000);
      
      fullResponse = await page.evaluate(() => {
        // Look for assistant message containers
        const messages = document.querySelectorAll('[data-message-author-role="assistant"], [class*="assistant"], [class*="markdown"], .agent-turn');
        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          return lastMsg.textContent?.trim() || '';
        }
        return '';
      });
    }
    
    if (!fullResponse?.trim()) {
      throw new Error('Empty response - no content received');
    }
    
    log('INFO', `Page ${pageObj.id} generated ${fullResponse.length} chars`);
    return fullResponse.trim();
    
  } finally {
    releasePage(pageObj);
  }
}

// ==================== HTTP Server ====================
const MODELS = [
  { id: 'gpt-5.1', name: 'GPT-5.1' },
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
        owned_by: 'openai'
      }))
    });
  }

  // Chat completions
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    try {
      const body = await parseBody(req);
      const { model = 'gpt-5.1', messages = [], stream = false } = body;
      
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

  sendJson(res, 404, { error: 'Not found' });
}

// ==================== Main ====================
async function main() {
  await initBrowser();
  
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    log('INFO', `ChatGPT Server running on port ${PORT}`);
    log('INFO', `API Key: ${AUTH_TOKEN}`);
    log('INFO', 'Endpoints:');
    log('INFO', '  GET  /health               - Health check');
    log('INFO', '  GET  /v1/models            - List models');
    log('INFO', '  POST /v1/chat/completions  - Chat (stateless, each request = new chat)');
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
