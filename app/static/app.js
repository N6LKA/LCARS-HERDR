/* LCARS Claude Interface — Frontend */

let activeConvId = null;
let pendingImages = []; // [{dataUri, mimeType}]
let isStreaming = false;
let currentAssistantBubble = null;
let currentAssistantText = '';

// ─── Init ─────────────────────────────────────────────────────────

async function init() {
  await loadStatus();
  await loadConversations();
  setupInput();
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    document.getElementById('status-servers').textContent =
      `${d.servers.length} SERVERS`;
    document.getElementById('status-tools').textContent =
      `${d.tool_count} TOOLS`;
  } catch {}
}

// ─── Conversations ─────────────────────────────────────────────────

async function loadConversations() {
  const r = await fetch('/api/conversations');
  const convs = await r.json();
  const list = document.getElementById('conversation-list');
  list.innerHTML = '';

  if (convs.length === 0) return;

  if (!activeConvId) activeConvId = convs[0].id;

  convs.forEach(c => {
    const el = document.createElement('div');
    el.className = 'lcars-conv-item' + (c.id === activeConvId ? ' active' : '');
    el.dataset.id = c.id;

    const title = document.createElement('span');
    title.textContent = c.title;
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    el.appendChild(title);

    const del = document.createElement('span');
    del.className = 'conv-delete';
    del.textContent = '×';
    del.title = 'Delete';
    del.onclick = (e) => { e.stopPropagation(); deleteConversation(c.id); };
    el.appendChild(del);

    el.onclick = () => switchConversation(c.id);
    list.appendChild(el);
  });

  // Load messages for active conversation
  await loadMessages(activeConvId);
}

async function newConversation() {
  const r = await fetch('/api/conversations', { method: 'POST' });
  const conv = await r.json();
  activeConvId = conv.id;
  clearMessages();
  await loadConversations();
}

async function deleteConversation(id) {
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (id === activeConvId) activeConvId = null;
  clearMessages();
  await loadConversations();
}

async function switchConversation(id) {
  if (isStreaming) return;
  await fetch(`/api/conversations/${id}/activate`, { method: 'POST' });
  activeConvId = id;
  clearMessages();
  await loadMessages(id);
  document.querySelectorAll('.lcars-conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

async function loadMessages(convId) {
  const r = await fetch(`/api/conversations/${convId}/messages`);
  const messages = await r.json();
  clearMessages();
  messages.forEach(msg => {
    if (msg.role === 'user') {
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
      renderUserMessage(content);
    } else {
      const text = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : msg.content;
      renderAssistantMessage(text);
    }
  });
  scrollToBottom();
}

// ─── Messages rendering ────────────────────────────────────────────

function clearMessages() {
  document.getElementById('messages').innerHTML = '';
  currentAssistantBubble = null;
  currentAssistantText = '';
}

function renderUserMessage(content) {
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'OPERATOR';
  wrap.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  content.forEach(block => {
    if (block.type === 'text' && block.text) {
      const p = document.createElement('p');
      p.textContent = block.text;
      bubble.appendChild(p);
    } else if (block.type === 'image') {
      const img = document.createElement('img');
      img.className = 'msg-image';
      const src = block.source;
      if (src.type === 'base64') {
        img.src = `data:${src.media_type};base64,${src.data}`;
      } else if (src.type === 'url') {
        img.src = src.url;
      }
      bubble.appendChild(img);
    }
  });

  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
}

function renderAssistantMessage(text) {
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'CLAUDE';
  wrap.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = renderMarkdown(text);
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  return bubble;
}

function startStreamingAssistant() {
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'CLAUDE';
  wrap.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble streaming-cursor';
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  currentAssistantBubble = bubble;
  currentAssistantText = '';
  return bubble;
}

function appendStreamText(text) {
  if (!currentAssistantBubble) startStreamingAssistant();
  currentAssistantText += text;
  currentAssistantBubble.innerHTML = renderMarkdown(currentAssistantText);
  scrollToBottom();
}

function appendToolChip(toolName) {
  if (!currentAssistantBubble) startStreamingAssistant();
  const chip = document.createElement('span');
  chip.className = 'tool-chip';
  chip.textContent = toolName;
  currentAssistantBubble.appendChild(chip);
  scrollToBottom();
}

function finalizeAssistant() {
  if (currentAssistantBubble) {
    currentAssistantBubble.classList.remove('streaming-cursor');
    currentAssistantBubble = null;
    currentAssistantText = '';
  }
}

function scrollToBottom() {
  const msgs = document.getElementById('messages');
  msgs.scrollTop = msgs.scrollHeight;
}

// ─── Simple Markdown renderer ──────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return '';

  // Code blocks
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code class="lang-${lang}">${escaped}</code></pre>`;
  });

  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });

  // Headers
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // HR
  text = text.replace(/^---+$/gm, '<hr>');

  // Bold / italic
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Unordered lists
  text = text.replace(/((?:^[*\-] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[*\-] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  text = text.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Paragraphs (blank-line separated)
  const parts = text.split(/\n{2,}/);
  text = parts.map(p => {
    p = p.trim();
    if (!p) return '';
    if (p.startsWith('<')) return p;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return text;
}

// ─── Send message ──────────────────────────────────────────────────

async function sendMessage() {
  if (isStreaming) return;
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text && pendingImages.length === 0) return;

  isStreaming = true;
  document.getElementById('send-btn').disabled = true;
  input.value = '';

  // Render user message
  const userContent = [];
  pendingImages.forEach(img => {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.b64 },
    });
  });
  if (text) userContent.push({ type: 'text', text });
  renderUserMessage(userContent);
  scrollToBottom();

  // Clear image tray
  const imageUris = pendingImages.map(i => i.dataUri);
  pendingImages = [];
  updateImageTray();

  // Show thinking
  setThinking(true);
  startStreamingAssistant();

  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: activeConvId,
        text: text,
        images: imageUris,
      }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const rawData = line.slice(5).trim();
        if (!rawData) continue;
        try {
          const eventLine = lines[lines.indexOf(line) - 1] || '';
          const event = eventLine.startsWith('event:') ? eventLine.slice(6).trim() : 'message';
          handleSSEData(event, rawData);
        } catch {}
      }
    }

  } catch (e) {
    appendStreamText(`\n\n*Connection error: ${e.message}*`);
  } finally {
    setThinking(false);
    finalizeAssistant();
    isStreaming = false;
    document.getElementById('send-btn').disabled = false;
    await loadConversations();
    input.focus();
  }
}

let sseBuffer = '';
let lastEvent = '';

async function streamSSE(body) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    let currentEvent = 'message';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        if (raw) handleSSEData(currentEvent, raw);
        currentEvent = 'message';
      }
    }
  }
}

function handleSSEData(event, raw) {
  try {
    const data = JSON.parse(raw);
    if (event === 'text' || event === 'message') {
      if (data.text) {
        setThinking(false);
        appendStreamText(data.text);
      }
    } else if (event === 'thinking') {
      setThinking(true, 'REASONING');
    } else if (event === 'tool_use') {
      setThinking(true, data.tool);
      appendToolChip(data.tool);
    } else if (event === 'start') {
      if (data.conversation_id) activeConvId = data.conversation_id;
    } else if (event === 'error') {
      appendStreamText(`\n\n*Error: ${data.error}*`);
    }
  } catch {}
}

// ─── Send (refactored to use streamSSE) ───────────────────────────

async function sendMessage() {
  if (isStreaming) return;
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text && pendingImages.length === 0) return;

  isStreaming = true;
  document.getElementById('send-btn').disabled = true;
  input.value = '';

  // Render user message preview
  const userContent = [];
  pendingImages.forEach(img => {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.b64 } });
  });
  if (text) userContent.push({ type: 'text', text });
  renderUserMessage(userContent);
  scrollToBottom();

  const imageUris = pendingImages.map(i => i.dataUri);
  pendingImages = [];
  updateImageTray();

  setThinking(true);
  startStreamingAssistant();

  try {
    await streamSSE({ conversation_id: activeConvId, text, images: imageUris });
  } catch (e) {
    appendStreamText(`\n\n*Connection error: ${e.message}*`);
  } finally {
    setThinking(false);
    finalizeAssistant();
    isStreaming = false;
    document.getElementById('send-btn').disabled = false;
    await loadConversations();
    input.focus();
  }
}

// ─── Thinking indicator ────────────────────────────────────────────

function setThinking(on, toolName = '') {
  const bar = document.getElementById('thinking-bar');
  const toolEl = document.getElementById('thinking-tool');
  bar.style.display = on ? 'flex' : 'none';
  toolEl.textContent = toolName ? `▶ ${toolName.toUpperCase()}` : '';
}

// ─── Input setup ──────────────────────────────────────────────────

function setupInput() {
  const input = document.getElementById('message-input');

  // Enter = send, Alt+Enter = new line
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Clipboard image paste (Ctrl+V)
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let handled = false;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        handled = true;
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUri = ev.target.result;
          const b64 = dataUri.split(',')[1];
          pendingImages.push({ dataUri, b64, mimeType: item.type });
          updateImageTray();
        };
        reader.readAsDataURL(blob);
      }
    }
  });

  input.focus();
}

// ─── Image tray ────────────────────────────────────────────────────

function updateImageTray() {
  const tray = document.getElementById('image-tray');
  if (pendingImages.length === 0) {
    tray.style.display = 'none';
    tray.innerHTML = '';
    return;
  }
  tray.style.display = 'flex';
  // Keep the ::before label via CSS; rebuild thumbnails
  const existing = tray.querySelectorAll('.image-preview-wrap');
  existing.forEach(el => el.remove());

  pendingImages.forEach((img, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'image-preview-wrap';

    const thumb = document.createElement('img');
    thumb.className = 'image-preview-thumb';
    thumb.src = img.dataUri;
    wrap.appendChild(thumb);

    const rm = document.createElement('button');
    rm.className = 'image-preview-remove';
    rm.textContent = '×';
    rm.onclick = () => {
      pendingImages.splice(idx, 1);
      updateImageTray();
    };
    wrap.appendChild(rm);
    tray.appendChild(wrap);
  });
}

// ─── Start ─────────────────────────────────────────────────────────

init();
