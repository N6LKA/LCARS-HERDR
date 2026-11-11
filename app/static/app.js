/* LCARS Claude Interface — Frontend */

let activeConvId = null;
let _activeConvIsRemote = false;
let _activeConvSessionId = null;
let pendingImages = [];
let isStreaming = false;
let currentAssistantBubble = null;
let currentAssistantText = '';
let messageQueue = [];      // queued while streaming: [{text, imageUris, userContent}]
let abortController = null; // for stopping the current stream
let _responseStartTime = 0;
let _metricsBarTargets = { cpu: 30, ram: 50 };
let _footerBarRefs = null;  // set by initFooterBars
let _msgCount = 0;
let _audioCtx = null;
let _lastClickSound = 0;
let _alertMode = 'none';
let _alertSoundInterval = null;
let _clickSounds = [];
let _transmitSounds = [];
let _redAlertAudio = null;
let _audioEnabled = true;
let _animFrame = null;
let _viewMode = localStorage.getItem('lcars-view-mode') || 'dna';
let _warpFuel = parseInt(localStorage.getItem('lcars-warp-fuel') || '50', 10);
let _warpCtrlBtns = [];

function formatTime() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function addMsgMeta(wrap, extra = '') {
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = formatTime() + (extra ? '  ·  ' + extra : '');
  wrap.appendChild(meta);
}

// ─── Init ─────────────────────────────────────────────────────────

async function init() {
  await loadStatus();
  await loadConversations();
  setupInput();
  initTelemetry();
  initRightPanel();
  initDataGrid();
  initFooterBars();
  initStarfield();
  initAudio();
  updateAutoAuthBtn();
  pollMetrics();
  applyBtnConfig(loadBtnConfig());
}

async function loadStatus() {
  // status-servers / status-tools removed; replaced by session ID display
}

function setSessionIdDisplay(sessionId) {
  const el = document.getElementById('session-id-display');
  if (!el) return;
  if (sessionId) {
    el.textContent = sessionId;
    el.title = sessionId;
  } else {
    el.textContent = 'NO ACTIVE SESSION';
    el.title = '';
  }
  // reset copy button if it was in copied state
  const btn = document.getElementById('session-copy-btn');
  if (btn) btn.classList.remove('copied');
}

async function copySessionId() {
  const el = document.getElementById('session-id-display');
  const btn = document.getElementById('session-copy-btn');
  const text = el?.textContent?.trim();
  if (!text || text === 'NO ACTIVE SESSION') return;
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    btn.textContent = '✓';
    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = '&#10697;'; }, 1800);
  } catch {}
}

// ─── Uplink button ────────────────────────────────────────────────

function updateUplinkBtn() {
  const btn = document.getElementById('btn-uplink');
  if (!btn) return;
  const hasSession = !!_activeConvSessionId;
  btn.disabled = !hasSession;
  if (_activeConvIsRemote) {
    btn.textContent = 'SYNC UPLINK MSG';
    btn.className = 'lcars-btn lcars-btn-sync-uplink';
  } else {
    btn.textContent = 'UPLINK SESSION';
    btn.className = 'lcars-btn lcars-btn-uplink';
  }
}

async function handleUplinkBtn() {
  if (!activeConvId) return;
  if (_activeConvIsRemote) {
    await syncUplink();
  } else {
    await enableUplink();
  }
}

async function enableUplink() {
  const btn = document.getElementById('btn-uplink');
  if (btn) { btn.disabled = true; btn.textContent = 'LINKING...'; }
  try {
    const r = await fetch(`/api/conversations/${activeConvId}/uplink`, { method: 'POST' });
    if (!r.ok) {
      const err = await r.json();
      alert('Uplink failed: ' + (err.detail || r.status));
      return;
    }
    const conv = await r.json();
    _activeConvIsRemote = conv.is_remote;
    _activeConvSessionId = conv.claude_session_id || null;
    setSessionIdDisplay(conv.claude_session_id || null);
    if (conv.remote_url) {
      showUplinkUrl(conv.remote_url);
    }
  } catch (e) {
    alert('Uplink error: ' + e.message);
  } finally {
    updateUplinkBtn();
  }
}

function showUplinkUrl(url) {
  // Insert a system-style message in the chat showing the remote URL
  const box = document.createElement('div');
  box.className = 'lcars-uplink-notice';
  box.innerHTML =
    '<span class="lcars-uplink-icon">&#9889;</span>' +
    '<span class="lcars-uplink-label">UPLINK ACTIVE — </span>' +
    '<a class="lcars-uplink-url" href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
  const msgs = document.getElementById('messages');
  if (msgs) {
    msgs.appendChild(box);
    scrollToBottom();
  }
}

async function syncUplink() {
  const btn = document.getElementById('btn-uplink');
  if (btn) { btn.disabled = true; btn.textContent = 'SYNCING...'; }
  try {
    const r = await fetch(`/api/conversations/${activeConvId}/sync`, { method: 'POST' });
    if (!r.ok) {
      const err = await r.json();
      alert('Sync failed: ' + (err.detail || r.status));
      return;
    }
    await loadMessages(activeConvId);
  } catch (e) {
    alert('Sync error: ' + e.message);
  } finally {
    updateUplinkBtn();
  }
}

// ─── Conversations ─────────────────────────────────────────────────

async function loadConversations() {
  const r = await fetch('/api/conversations');
  const convs = await r.json();
  const list = document.getElementById('conversation-list');
  list.innerHTML = '';

  const sessEl = document.getElementById('telem-sessions');
  if (sessEl) sessEl.textContent = convs.length;

  if (convs.length === 0) return;

  if (!activeConvId) activeConvId = convs[0].id;

  // Update session ID display and uplink button for the active conversation
  const activeConv = convs.find(c => c.id === activeConvId);
  if (activeConv) {
    setSessionIdDisplay(activeConv.claude_session_id || null);
    _activeConvSessionId = activeConv.claude_session_id || null;
    _activeConvIsRemote = activeConv.is_remote || false;
  }
  updateUplinkBtn();

  convs.forEach(c => {
    const el = document.createElement('div');
    el.className = 'lcars-conv-item' + (c.id === activeConvId ? ' active' : '');
    el.dataset.id = c.id;

    const title = document.createElement('span');
    title.textContent = c.title;
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.title = 'Double-click to rename';
    title.ondblclick = (e) => { e.stopPropagation(); startRename(c.id, c.title, title, el); };
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
  _activeConvSessionId = null;
  _activeConvIsRemote = false;
  setSessionIdDisplay(null);
  updateUplinkBtn();
  clearMessages();
  await loadConversations();
}

function showResumePanel() {
  const panel = document.getElementById('resume-panel');
  panel.style.display = 'flex';
  document.getElementById('resume-input').focus();
}

function hideResumePanel() {
  document.getElementById('resume-panel').style.display = 'none';
  document.getElementById('resume-input').value = '';
}

async function confirmResume() {
  const sessionId = document.getElementById('resume-input').value.trim();
  if (!sessionId) return;
  const r = await fetch('/api/conversations/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, title: 'Session ' + sessionId.slice(0, 8) }),
  });
  const conv = await r.json();
  activeConvId = conv.id;
  hideResumePanel();
  clearMessages();
  await loadConversations();
}

function startRename(convId, currentTitle, titleEl, rowEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.className = 'conv-rename-input';
  input.style.flex = '1';
  titleEl.replaceWith(input);
  rowEl.onclick = null;
  input.focus();
  input.select();

  async function commit() {
    const newTitle = input.value.trim() || currentTitle;
    await fetch(`/api/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle }),
    });
    await loadConversations();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { loadConversations(); }
  });
  input.addEventListener('blur', commit);
}

async function deleteConversation(id) {
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (id === activeConvId) activeConvId = null;
  clearMessages();
  await loadConversations();
}

async function switchConversation(id) {
  if (isStreaming) return;
  const r = await fetch(`/api/conversations/${id}/activate`, { method: 'POST' });
  const conv = await r.json();
  activeConvId = id;
  _activeConvSessionId = conv.claude_session_id || null;
  _activeConvIsRemote = conv.is_remote || false;
  setSessionIdDisplay(conv.claude_session_id || null);
  updateUplinkBtn();
  clearMessages();
  await loadMessages(id);
  document.querySelectorAll('.lcars-conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  updateAutoAuthBtn();
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
  _msgCount = messages.length;
  const el = document.getElementById('telem-msgs');
  if (el) el.textContent = _msgCount;
  scrollToBottom();
}

// ─── Messages rendering ────────────────────────────────────────────

function clearMessages() {
  document.getElementById('messages').innerHTML = '';
  currentAssistantBubble = null;
  currentAssistantText = '';
  _msgCount = 0;
  const el = document.getElementById('telem-msgs');
  if (el) el.textContent = '0';
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
  addMsgMeta(wrap);
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
  addMsgMeta(wrap);
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
  _responseStartTime = Date.now();
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
    const elapsed = ((Date.now() - _responseStartTime) / 1000).toFixed(1);
    addMsgMeta(currentAssistantBubble.parentElement, elapsed + 's');
    currentAssistantBubble = null;
    currentAssistantText = '';
    playChirp();
    _msgCount++;
    const el = document.getElementById('telem-msgs');
    if (el) el.textContent = _msgCount;
  }
}

function scrollToBottom(force = false) {
  const msgs = document.getElementById('messages');
  if (!msgs) return;
  const distFromBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
  if (force || distFromBottom < 200) {
    requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
  }
}

// ─── Simple Markdown renderer ──────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return '';

  // Code blocks
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langLabel = lang ? lang.toUpperCase() : 'CODE';
    return `<div class="lcars-code-block"><div class="lcars-code-header"><span class="lcars-code-lang">${langLabel}</span><button class="lcars-code-copy" onclick="copyCode(this)">COPY</button></div><pre><code class="lang-${lang}">${escaped}</code></pre></div>`;
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
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text && pendingImages.length === 0) return;

  // Slash commands
  if (text.startsWith('/')) {
    const cmd = text.toLowerCase();
    if (cmd === '/mp' || cmd === '/mempalace') {
      input.value = '';
      sendMempalace();
      return;
    }
    if (cmd === '/gh' || cmd === '/github') {
      input.value = '';
      sendGitHub();
      return;
    }
    if (cmd === '/clear') {
      input.value = '';
      clearMessages();
      return;
    }
    if (cmd === '/help') {
      input.value = '';
      showSlashHelp();
      return;
    }
  }

  const userContent = [];
  pendingImages.forEach(img => {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.b64 } });
  });
  if (text) userContent.push({ type: 'text', text });

  const imageUris = pendingImages.map(i => i.dataUri);
  pendingImages = [];
  input.value = '';
  updateImageTray();

  if (isStreaming) {
    renderUserMessage(userContent);
    scrollToBottom();
    messageQueue.push({ text, imageUris, userContent, preRendered: true });
    updateQueueDisplay();
    return;
  }

  await doSend(text, imageUris, userContent);
}

async function doSend(text, imageUris, userContent, preRendered = false) {
  isStreaming = true;
  setHaltMode(true);

  if (!preRendered) {
    renderUserMessage(userContent);
  }
  _msgCount++;
  const _tcEl = document.getElementById('telem-msgs');
  if (_tcEl) _tcEl.textContent = _msgCount;
  scrollToBottom(true);
  setThinking(true);
  startStreamingAssistant();

  try {
    await streamSSE({ conversation_id: activeConvId, text, images: imageUris });
  } catch (e) {
    if (e.name !== 'AbortError') {
      appendStreamText(`\n\n*Connection error: ${e.message}*`);
    }
  } finally {
    setThinking(false);
    finalizeAssistant();
    isStreaming = false;
    setHaltMode(false);
    await loadConversations();

    if (messageQueue.length > 0) {
      const next = messageQueue.shift();
      updateQueueDisplay();
      await doSend(next.text, next.imageUris, next.userContent, next.preRendered);
    } else {
      updateQueueDisplay();
      document.getElementById('message-input').focus();
    }
  }
}

async function streamSSE(body) {
  abortController = new AbortController();
  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let currentEvent = 'message';  // persist across chunk boundaries

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const raw = line.slice(5).trim();
          if (raw) handleSSEData(currentEvent, raw);
          currentEvent = 'message';
        } else if (line === '') {
          currentEvent = 'message';  // blank line = event boundary
        }
      }
    }
  } finally {
    abortController = null;
  }
}

function stopGeneration() {
  if (abortController) {
    abortController.abort();
  }
  messageQueue = [];
  updateQueueDisplay();
}

function setHaltMode(on) {
  const btn = document.getElementById('send-btn');
  if (on) {
    btn.textContent = '■ HALT';
    btn.classList.add('halting');
    btn.onclick = stopGeneration;
  } else {
    btn.textContent = 'TRANSMIT';
    btn.classList.remove('halting');
    btn.onclick = sendMessage;
  }
}

function updateQueueDisplay() {
  const indicator = document.getElementById('queue-indicator');
  const countEl = document.getElementById('queue-count');
  if (messageQueue.length > 0) {
    indicator.style.display = 'flex';
    countEl.textContent = messageQueue.length;
  } else {
    indicator.style.display = 'none';
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
    } else if (event === 'session') {
      if (data.session_id) {
        setSessionIdDisplay(data.session_id);
        _activeConvSessionId = data.session_id;
        updateUplinkBtn();
      }
    } else if (event === 'start') {
      if (data.conversation_id) activeConvId = data.conversation_id;
    } else if (event === 'error') {
      appendStreamText(`\n\n*Error: ${data.error}*`);
    } else if (event === 'usage') {
      updateTokenTelemetry(data);
    } else if (event === 'done') {
      // Update sidebar title and ensure session state is current
      if (data.title && activeConvId) {
        const item = document.querySelector(`.lcars-conv-item[data-id="${activeConvId}"] span`);
        if (item) item.textContent = data.title;
      }
    } else if (event === 'permission_request') {
      showPermissionModal(data.req_id, data.tool, data.input);
    }
  } catch {}
}

// ─── Permission modal ──────────────────────────────────────────────

let pendingPermReqId = null;

function showPermissionModal(reqId, tool, input) {
  pendingPermReqId = reqId;
  document.getElementById('perm-tool-name').textContent = tool.toUpperCase();

  // Pick the most useful field to display as the target
  let detail = '';
  if (input.file_path) {
    detail = input.file_path;
  } else if (input.command) {
    detail = input.command;
  } else if (input.url) {
    detail = input.url;
  } else {
    detail = JSON.stringify(input, null, 2);
  }
  document.getElementById('perm-detail').textContent = detail;
  document.getElementById('perm-overlay').style.display = 'flex';
}

async function respondToPermission(decision, allSession = false) {
  if (!pendingPermReqId) return;
  const reqId = pendingPermReqId;
  pendingPermReqId = null;
  hidePermissionModal();

  if (allSession && decision === 'allow') {
    setSessionAllowIndicator(true);
    updateAutoAuthBtn();
  }

  try {
    await fetch(`/api/permission/response/${reqId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, all_session: allSession }),
    });
  } catch (e) {
    console.error('Failed to send permission response:', e);
  }
}

function hidePermissionModal() {
  document.getElementById('perm-overlay').style.display = 'none';
}

function setSessionAllowIndicator(active) {
  document.getElementById('session-allow-indicator').style.display = active ? 'flex' : 'none';
}

async function revokeSessionAllow() {
  if (!activeConvId) return;
  setSessionAllowIndicator(false);
  try {
    await fetch(`/api/permission/session-allow/${activeConvId}`, { method: 'DELETE' });
    updateAutoAuthBtn();
  } catch (e) {
    console.error('Failed to revoke session allow:', e);
  }
}

// ─── Sidebar buttons ───────────────────────────────────────────────

async function updateAutoAuthBtn() {
  if (!activeConvId) return;
  try {
    const r = await fetch(`/api/permission/session-status/${activeConvId}`);
    const d = await r.json();
    const btn = document.getElementById('btn-auto-auth');
    if (!btn) return;
    if (d.allow_all) {
      btn.textContent = 'AUTH: ON';
      btn.classList.add('active');
    } else {
      btn.textContent = 'AUTH: OFF';
      btn.classList.remove('active');
    }
  } catch {}
}

async function toggleAutoAuth() {
  if (!activeConvId) return;
  const btn = document.getElementById('btn-auto-auth');
  const isOn = btn && btn.classList.contains('active');
  try {
    if (isOn) {
      await fetch(`/api/permission/session-allow/${activeConvId}`, { method: 'DELETE' });
      setSessionAllowIndicator(false);
    } else {
      await fetch(`/api/permission/session-allow/${activeConvId}`, { method: 'POST' });
      setSessionAllowIndicator(true);
    }
    await updateAutoAuthBtn();
  } catch (e) {
    console.error('Failed to toggle auto-auth:', e);
  }
}

function sendMempalace() {
  const input = document.getElementById('message-input');
  if (!input) return;
  input.value = 'Please save everything from this session to MemPalace. Use mempalace_diary_write to record what we worked on, mempalace_kg_add for any key facts, and mempalace_add_drawer for any new reference material. Summarize the session thoroughly.';
  input.focus();
}

function sendGitHub() {
  const input = document.getElementById('message-input');
  if (!input) return;
  input.value = 'Please commit all current changes and push to GitHub. Write a concise commit message summarizing what changed.';
  input.focus();
}

// ─── Configurable sidebar buttons ──────────────────────────────────

const BTN_COLORS = [
  { name: 'teal',   grad: 'linear-gradient(90deg, #1a8090, #0d5265)', dur: '4.3s', delay: '1.4s' },
  { name: 'gold',   grad: 'linear-gradient(90deg, #a07828, #6a4e10)', dur: '6.1s', delay: '2.9s' },
  { name: 'blue',   grad: 'linear-gradient(90deg, #3a7bd5, #1f4a8a)', dur: '5.0s', delay: '0.7s' },
  { name: 'green',  grad: 'linear-gradient(90deg, #30d060, #20a040)', dur: '4.8s', delay: '1.9s' },
  { name: 'red',    grad: 'linear-gradient(90deg, #d06040, #963020)', dur: '5.5s', delay: '3.2s' },
  { name: 'purple', grad: 'linear-gradient(90deg, #6040c8, #3a2090)', dur: '4.7s', delay: '1.1s' },
  { name: 'navy',   grad: 'linear-gradient(90deg, #253545, #152030)', dur: '5.3s', delay: '2.1s' },
];

const DEFAULT_BTNS = [
  { label: 'BUTTON 1',    color: 'blue', cmd: '' },
  { label: 'BUTTON 2',    color: 'navy', cmd: '' },
  { label: 'PUSH TO GITHUB', color: 'teal',
    cmd: 'Please use git bash commands to stage, commit, and push all current changes to GitHub. Use git add, git commit with a concise message, and git push origin main.' },
  { label: 'SAVE TO MEMPALACE', color: 'gold',
    cmd: 'Please save everything from this session to MemPalace. Use mempalace_diary_write to record what we worked on, mempalace_kg_add for any key facts, and mempalace_add_drawer for any new reference material. Summarize the session thoroughly.' },
];

function loadVolume() {
  return parseFloat(localStorage.getItem('lcars-volume') ?? '0.20');
}

function applyVolume(vol) {
  const alertMult = 0.8;
  _clickSounds.forEach(a => a.volume = vol);
  _transmitSounds.forEach(a => a.volume = vol);
  if (_redAlertAudio) _redAlertAudio.volume = vol * alertMult;
}

function loadBtnConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('lcars-custom-btns-v4')) || [];
    return DEFAULT_BTNS.map((def, i) => saved[i] ? { ...def, ...saved[i] } : def);
  } catch { return DEFAULT_BTNS; }
}

function applyBtnConfig(config) {
  config.forEach((cfg, i) => {
    const btn = document.getElementById(`custom-btn-${i}`);
    if (!btn) return;
    btn.textContent = cfg.label;
    const col = BTN_COLORS.find(c => c.name === cfg.color) || BTN_COLORS[0];
    btn.style.background = col.grad;
    btn.style.setProperty('--shimmer-dur',   col.dur);
    btn.style.setProperty('--shimmer-delay', col.delay);
    btn.style.color = 'rgba(255,255,255,0.85)';
    btn.style.fontSize = '8px';
    btn.style.fontWeight = '800';
    btn.style.letterSpacing = '2px';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'flex-start';
    btn.style.paddingLeft = '12px';
    btn.style.textTransform = 'uppercase';
    btn.style.transition = 'filter 0.2s';
  });
}

function fireCustomBtn(idx) {
  const cfg = loadBtnConfig()[idx];
  const input = document.getElementById('message-input');
  if (input && cfg?.cmd) { input.value = cfg.cmd; input.focus(); }
}

let _cfgColors = [];

function openButtonSettings() {
  const config = loadBtnConfig();
  _cfgColors = config.map(c => c.color);
  config.forEach((cfg, i) => {
    document.getElementById(`cfg-label-${i}`).value = cfg.label;
    document.getElementById(`cfg-cmd-${i}`).value   = cfg.cmd;
    renderSwatches(i, cfg.color);
  });
  const vol = loadVolume();
  const slider = document.getElementById('cfg-volume');
  slider.value = vol;
  document.getElementById('cfg-volume-val').textContent = Math.round(vol * 100) + '%';
  document.getElementById('btn-settings-overlay').style.display = 'flex';
}

function renderSwatches(idx, selected) {
  const row = document.getElementById(`cfg-colors-${idx}`);
  row.innerHTML = '';
  BTN_COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'lcars-color-swatch' + (c.name === selected ? ' selected' : '');
    sw.style.background = c.grad;
    sw.title = c.name.toUpperCase();
    sw.onclick = () => { _cfgColors[idx] = c.name; renderSwatches(idx, c.name); };
    row.appendChild(sw);
  });
}

function closeButtonSettings() {
  document.getElementById('btn-settings-overlay').style.display = 'none';
}

function saveButtonSettings() {
  const config = loadBtnConfig();
  config.forEach((cfg, i) => {
    const lbl = document.getElementById(`cfg-label-${i}`).value.trim();
    const cmd = document.getElementById(`cfg-cmd-${i}`).value.trim();
    if (lbl) cfg.label = lbl;
    if (cmd) cfg.cmd   = cmd;
    cfg.color = _cfgColors[i];
  });
  localStorage.setItem('lcars-custom-btns-v4', JSON.stringify(config));
  applyBtnConfig(config);
  const vol = parseFloat(document.getElementById('cfg-volume').value);
  localStorage.setItem('lcars-volume', vol);
  applyVolume(vol);
  closeButtonSettings();
}

function showSlashHelp() {
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';

  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'SYSTEM';
  wrap.appendChild(label);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = `<p><strong>SLASH COMMANDS</strong></p><ul>
    <li><code>/help</code> — Show this help</li>
    <li><code>/clear</code> — Clear message display</li>
    <li><code>/mp</code> or <code>/mempalace</code> — Save session to MemPalace</li>
    <li><code>/gh</code> or <code>/github</code> — Commit and push to GitHub</li>
  </ul>`;
  wrap.appendChild(bubble);
  addMsgMeta(wrap);
  msgs.appendChild(wrap);
  scrollToBottom(true);
}

function copyCode(btn) {
  const pre = btn.closest('.lcars-code-block').querySelector('pre');
  const text = pre ? pre.textContent : '';

  function showCopied() {
    const orig = btn.textContent;
    btn.textContent = 'COPIED';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  }

  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); showCopied(); } catch {}
    document.body.removeChild(ta);
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(showCopied).catch(fallback);
  } else {
    fallback();
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

  document.getElementById('send-btn').onclick = sendMessage;

  // Enter = send, Alt+Enter = new line
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      playTransmit();
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

  // Enter in resume input = confirm
  document.getElementById('resume-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmResume();
    if (e.key === 'Escape') hideResumePanel();
  });

  // Custom top-right resize handle — drag upward to grow input
  const handle = document.getElementById('resize-handle');
  const wrapper = handle.closest('.lcars-input-wrapper');

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = wrapper.offsetHeight;

    const onMove = (e) => {
      const delta = startY - e.clientY; // positive = dragged up
      const newH = Math.max(60, startHeight + delta);
      wrapper.style.height = newH + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
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

// ─── Audio ─────────────────────────────────────────────────────────

function getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  return _audioCtx;
}

function _beep(ctx, freq1, freq2, tStart, dur, vol = 0.09, type = 'sine') {
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = type;
    o.frequency.setValueAtTime(freq1, tStart);
    o.frequency.linearRampToValueAtTime(freq2, tStart + dur);
    g.gain.setValueAtTime(0, tStart);
    g.gain.linearRampToValueAtTime(vol, tStart + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, tStart + dur + 0.01);
    o.start(tStart);
    o.stop(tStart + dur + 0.02);
  } catch {}
}

// Random Trek button click from preloaded pool
function playClick() {
  if (!_audioEnabled) return;
  const now = Date.now();
  if (now - _lastClickSound < 80) return;
  _lastClickSound = now;
  if (!_clickSounds.length) return;
  const snd = _clickSounds[Math.floor(Math.random() * _clickSounds.length)];
  snd.currentTime = 0;
  snd.play().catch(() => {});
}

// Transmit / send sound — input_ok pool
function playTransmit() {
  if (!_audioEnabled) return;
  if (!_transmitSounds.length) return;
  const snd = _transmitSounds[Math.floor(Math.random() * _transmitSounds.length)];
  snd.currentTime = 0;
  snd.play().catch(() => {});
}

function toggleAudio() {
  _audioEnabled = !_audioEnabled;
  if (!_audioEnabled) stopRedAlert();
  const btn = document.getElementById('audio-toggle-btn');
  if (btn) {
    btn.textContent = _audioEnabled ? 'AUDIO ON' : 'AUDIO OFF';
    btn.classList.toggle('active', _audioEnabled);
    btn.classList.toggle('muted', !_audioEnabled);
  }
}

// Trek completion chirp — precise AudioContext scheduling
function playChirp() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime;
  _beep(ctx, 523,  784,  t,        0.10, 0.12); // C5→G5
  _beep(ctx, 784,  1047, t + 0.13, 0.12, 0.12); // G5→C6
}

// Red alert — loops the actual TNG klaxon file
function playRedAlert() {
  if (!_audioEnabled || !_redAlertAudio) return;
  _redAlertAudio.currentTime = 0;
  _redAlertAudio.play().catch(() => {});
}

function stopRedAlert() {
  if (!_redAlertAudio) return;
  _redAlertAudio.pause();
  _redAlertAudio.currentTime = 0;
}

// Yellow alert — triangle wave two-tone warning
function playYellowAlert() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'triangle';
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(600, t);
    o.frequency.setValueAtTime(400, t + 0.18);
    o.frequency.setValueAtTime(600, t + 0.36);
    g.gain.setValueAtTime(0.13, t);
    g.gain.setValueAtTime(0.13, t + 0.40);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.50);
    o.start(t); o.stop(t + 0.55);
  } catch {}
}

function initAudio() {
  const vol = loadVolume();
  const mkAudio = (src, volMult = 1.0) => { const a = new Audio(src); a.preload = 'auto'; a.volume = Math.min(1, vol * volMult); return a; };

  _clickSounds = [
    'padd_1', 'padd_2', 'padd_3',
    'keyok1', 'keyok2', 'keyok3', 'keyok4', 'keyok5', 'keyok6',
  ].map(f => mkAudio(`/static/audio/${f}.mp3`));

  _transmitSounds = [
    'input_ok_1_clean', 'input_ok_2_clean', 'input_ok_4',
  ].map(f => mkAudio(`/static/audio/${f}.mp3`));

  _redAlertAudio = mkAudio('/static/audio/tng_red_alert3.mp3', 0.8);
  _redAlertAudio.loop = true;

  document.addEventListener('click', (e) => {
    if (e.target.closest('.lcars-send-btn')) {
      playTransmit();
    } else if (e.target.closest('.lcars-btn, .lcars-sidebar-block, .lcars-rp-func')) {
      playClick();
    }
  }, { passive: true });
}

// ─── Alert modes ───────────────────────────────────────────────────

function setAlertMode(mode) {
  const app = document.getElementById('app');
  const badge = document.getElementById('alert-badge');
  app.classList.remove('alert-red', 'alert-yellow');
  if (_alertSoundInterval) { clearInterval(_alertSoundInterval); _alertSoundInterval = null; }
  stopRedAlert();
  _alertMode = mode;
  if (mode === 'red') {
    app.classList.add('alert-red');
    if (badge) badge.textContent = 'RED ALERT';
    setTimeout(playRedAlert, 80);
  } else if (mode === 'yellow') {
    app.classList.add('alert-yellow');
    if (badge) badge.textContent = 'YELLOW ALERT';
    setTimeout(playYellowAlert, 80);
    _alertSoundInterval = setInterval(playYellowAlert, 12000);
  } else {
    if (badge) badge.textContent = '';
  }
  document.getElementById('alert-btn-red')?.classList.toggle('active', mode === 'red');
  document.getElementById('alert-btn-yellow')?.classList.toggle('active', mode === 'yellow');
}

// ─── Starfield ─────────────────────────────────────────────────────

function initStarfield() {
  const main = document.querySelector('.lcars-main');
  if (!main) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'lcars-starfield';
  main.insertBefore(canvas, main.firstChild);

  const stars = Array.from({ length: 110 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.35 + Math.random() * 0.95,
    baseAlpha: 0.14 + Math.random() * 0.44,
    phase: Math.random() * Math.PI * 2,
    speed: 0.007 + Math.random() * 0.02,
    dx: (Math.random() - 0.5) * 0.00005,
    dy: (Math.random() - 0.5) * 0.00005,
    blue: Math.random() < 0.32,
  }));

  // Observe the PARENT for size — canvas absolute positioning
  // with left/right/bottom CSS doesn't give reliable offsetWidth/Height
  function resize() {
    const inputH = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--input-h')) || 184;
    canvas.width  = main.clientWidth;
    canvas.height = Math.max(100, main.clientHeight - inputH);
  }
  new ResizeObserver(resize).observe(main);

  function draw() {
    const W = canvas.width, H = canvas.height;
    if (!W || !H) { requestAnimationFrame(draw); return; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    stars.forEach(s => {
      s.phase += s.speed * 0.016;
      s.x += s.dx; if (s.x < 0) s.x = 1; if (s.x > 1) s.x = 0;
      s.y += s.dy; if (s.y < 0) s.y = 1; if (s.y > 1) s.y = 0;
      const alpha = s.baseAlpha * (0.55 + Math.sin(s.phase) * 0.45);
      ctx.fillStyle = s.blue
        ? `rgba(160,210,255,${alpha.toFixed(2)})`
        : `rgba(215,225,255,${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }

  requestAnimationFrame(() => { resize(); draw(); });
}

// ─── Right panel ───────────────────────────────────────────────────

function initRightPanel() {
  const panel = document.getElementById('right-panel');
  if (!panel) return;

  // ── Functional alert controls at top ──
  const rLabel = document.createElement('div');
  rLabel.className = 'lcars-rp-label';
  rLabel.textContent = 'ALERT';
  panel.appendChild(rLabel);

  const redBtn = document.createElement('div');
  redBtn.className = 'lcars-rp-btn lcars-rp-func lcars-rp-alert-red';
  redBtn.id = 'alert-btn-red';
  redBtn.textContent = 'RED ALERT';
  redBtn.title = 'Toggle Red Alert';
  redBtn.onclick = () => setAlertMode(_alertMode === 'red' ? 'none' : 'red');
  panel.appendChild(redBtn);

  const ylwBtn = document.createElement('div');
  ylwBtn.className = 'lcars-rp-btn lcars-rp-func lcars-rp-alert-yellow';
  ylwBtn.id = 'alert-btn-yellow';
  ylwBtn.textContent = 'YLW ALERT';
  ylwBtn.title = 'Toggle Yellow Alert';
  ylwBtn.onclick = () => setAlertMode(_alertMode === 'yellow' ? 'none' : 'yellow');
  panel.appendChild(ylwBtn);

  const sep = document.createElement('div');
  sep.style.cssText = 'height:6px;flex-shrink:0';
  panel.appendChild(sep);

  // ── Decorative random buttons ──
  const states = ['', '', '', 'rp-blue', 'rp-blue', 'rp-teal', 'rp-orange'];

  function makeCode() {
    const a = Math.floor(Math.random() * 89 + 10);
    const b = Math.floor(Math.random() * 899 + 100);
    return `${a}-${b}`;
  }

  function makeBtn() {
    const btn = document.createElement('div');
    btn.className = 'lcars-rp-btn';
    btn.textContent = makeCode();
    btn.style.setProperty('--rp-shimmer', (2.5 + Math.random() * 4).toFixed(1) + 's');
    btn.style.setProperty('--rp-delay',   (Math.random() * 4).toFixed(1) + 's');
    const cls = states[Math.floor(Math.random() * states.length)];
    if (cls) btn.classList.add(cls);
    return btn;
  }

  // Top buttons — track last 4 as potential warp controls
  const _topBtnRefs = [];
  for (let i = 0; i < 9; i++) {
    const b = makeBtn();
    panel.appendChild(b);
    _topBtnRefs.push(b);
  }
  _warpCtrlBtns = _topBtnRefs.slice(5);
  if (_viewMode === 'warp') activateWarpControls();

  // Double helix canvas in the middle
  const helixWrap = document.createElement('div');
  helixWrap.className = 'lcars-helix-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'lcars-helix-canvas';
  helixWrap.appendChild(canvas);
  panel.appendChild(helixWrap);

  if (_viewMode === 'warp') startWarpCore(canvas); else startHelix(canvas);

  // View mode toggle (DNA ↔ WARP CORE)
  const viewBtn = document.createElement('div');
  viewBtn.className = 'lcars-rp-btn lcars-rp-func lcars-rp-view' + (_viewMode === 'warp' ? ' warp' : '');
  viewBtn.id = 'view-toggle-btn';
  viewBtn.textContent = _viewMode === 'warp' ? 'DNA HELIX' : 'WARP CORE';
  viewBtn.title = 'Toggle warp core / DNA helix';
  viewBtn.onclick = () => toggleViewMode(canvas, viewBtn);
  panel.appendChild(viewBtn);

  // Bottom decorative buttons
  for (let i = 0; i < 4; i++) panel.appendChild(makeBtn());

  const audioBtn = document.createElement('div');
  audioBtn.className = 'lcars-rp-btn lcars-rp-func lcars-rp-audio active';
  audioBtn.id = 'audio-toggle-btn';
  audioBtn.textContent = 'AUDIO ON';
  audioBtn.title = 'Toggle audio on/off';
  audioBtn.onclick = () => toggleAudio();
  panel.appendChild(audioBtn);

  function cycle() {
    const btns = panel.querySelectorAll('.lcars-rp-btn:not(.lcars-rp-func)');
    if (!btns.length) return;
    const n = Math.random() < 0.3 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const btn = btns[Math.floor(Math.random() * btns.length)];
      btn.classList.remove('rp-blue', 'rp-teal', 'rp-orange');
      const cls = states[Math.floor(Math.random() * states.length)];
      if (cls) btn.classList.add(cls);
      if (Math.random() < 0.45) btn.textContent = makeCode();
    }
    setTimeout(cycle, 900 + Math.random() * 2200);
  }

  setTimeout(cycle, 1500);
}

function startHelix(canvas) {
  if (_animFrame) cancelAnimationFrame(_animFrame);
  const wrap = canvas.parentElement;
  let phase       = 0;
  let speed       = 0.022;
  let speedTarget = 0.022;
  let nextChange  = Date.now() + 4000;
  let shimmerY       = 0;
  let shimmerSpeed   = 0.0035;
  let shimmerTarget  = 0.0035;
  let nextShimmer    = Date.now() + 2000;

  function resize() {
    canvas.width  = wrap.clientWidth  || 90;
    canvas.height = wrap.clientHeight || 300;
  }
  new ResizeObserver(resize).observe(wrap);
  resize();

  function draw() {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Speed controller — smooth lerp toward a random target
    const now = Date.now();
    if (now > nextChange) {
      const r = Math.random();
      if      (r < 0.25) speedTarget = -(0.006 + Math.random() * 0.014); // reverse
      else if (r < 0.45) speedTarget =   0.003 + Math.random() * 0.008;  // slow crawl
      else               speedTarget =   0.016 + Math.random() * 0.014;  // normal/fast
      nextChange = now + 3000 + Math.random() * 5000;
    }
    speed += (speedTarget - speed) * 0.006;
    phase += speed;

    // Shimmer speed controller
    if (now > nextShimmer) {
      const r = Math.random();
      if      (r < 0.25) shimmerTarget = -(0.002 + Math.random() * 0.006); // reverse
      else if (r < 0.45) shimmerTarget =   0.001 + Math.random() * 0.003;  // slow
      else               shimmerTarget =   0.004 + Math.random() * 0.008;  // fast
      nextShimmer = now + 2000 + Math.random() * 4000;
    }
    shimmerSpeed += (shimmerTarget - shimmerSpeed) * 0.008;
    shimmerY += shimmerSpeed;
    if (shimmerY > 1.2) shimmerY = -0.2;
    if (shimmerY < -0.2) shimmerY = 1.2;

    const cx  = W / 2;
    const amp = W * 0.28;
    const wl  = 80;

    // Rungs between strands
    for (let y = 0; y < H; y += 5) {
      const a  = (y / wl) * Math.PI * 2 + phase;
      const x1 = cx + Math.sin(a) * amp;
      const x2 = cx + Math.sin(a + Math.PI) * amp;
      const depthFactor = Math.abs(Math.cos(a));
      if (depthFactor < 0.75) {
        const alpha = (0.75 - depthFactor) * 0.45;
        ctx.strokeStyle = `rgba(80,190,220,${alpha.toFixed(2)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
      }
    }

    function drawStrand(offset, colorFn) {
      for (let y = 0; y < H; y += 2) {
        const a     = (y / wl) * Math.PI * 2 + phase + offset;
        const x     = cx + Math.sin(a) * amp;
        const depth = (Math.sin(a) + 1) / 2;
        const r     = 1.5 + depth * 2.5;
        const alpha = 0.25 + depth * 0.75;
        const [cr, cg, cb] = colorFn(depth);
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawStrand(0,        d => [~~(20  + d * 30),  ~~(150 + d * 80),  220]);
    drawStrand(Math.PI,  d => [~~(210 + d * 45),  ~~(70  + d * 40),  ~~(20 + d * 10)]);

    // Vertical shimmer sweep
    const sY = shimmerY * H;
    const sg = ctx.createLinearGradient(0, sY - 55, 0, sY + 55);
    sg.addColorStop(0,   'rgba(255,255,255,0)');
    sg.addColorStop(0.5, 'rgba(255,255,255,0.13)');
    sg.addColorStop(1,   'rgba(255,255,255,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, sY - 55, W, 110);

    _animFrame = requestAnimationFrame(draw);
  }

  _animFrame = requestAnimationFrame(draw);
}

function startWarpCore(canvas) {
  if (_animFrame) cancelAnimationFrame(_animFrame);
  const wrap = canvas.parentElement;
  let speed = 0.4, speedTarget = 0.4;
  let nextSpeedChange = Date.now() + 4000;
  let offset = 0, t = 0;
  const BAND     = 30;   // plasma wavelength (px)
  const RING_GAP = 18;   // structural injector ring spacing (px)

  function resize() {
    canvas.width  = wrap.clientWidth  || 80;
    canvas.height = wrap.clientHeight || 300;
  }
  new ResizeObserver(resize).observe(wrap);
  resize();

  function draw() {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const now = Date.now();
    if (now > nextSpeedChange) {
      const fuelBase = 0.08 + (_warpFuel / 100) * 1.05;
      const r = Math.random();
      if      (r < 0.30) speedTarget = fuelBase * (0.35 + Math.random() * 0.25);
      else if (r < 0.70) speedTarget = fuelBase * (0.70 + Math.random() * 0.40);
      else               speedTarget = fuelBase * (1.05 + Math.random() * 0.35);
      nextSpeedChange = now + 4000 + Math.random() * 7000;
    }
    speed  += (speedTarget - speed) * 0.010;
    offset += speed;
    t++;

    const midY   = H / 2;
    const railW  = Math.max(10, Math.round(W * 0.155));
    const tubeX  = railW;
    const tubeW  = W - 2 * railW;
    const nBands = Math.ceil(midY / BAND) + 2;
    const pulse  = 0.62 + 0.38 * Math.sin(t * 0.052);
    const houseH = 56;   // reaction chamber height (taller = more prominent)

    // Horizontal tube-depth gradient helper
    function tGrad(r, g, b, aC, aE) {
      const gr = ctx.createLinearGradient(tubeX, 0, tubeX + tubeW, 0);
      gr.addColorStop(0,    `rgba(${r},${g},${b},${aE.toFixed(3)})`);
      gr.addColorStop(0.15, `rgba(${r},${g},${b},${(aC*0.80).toFixed(3)})`);
      gr.addColorStop(0.5,  `rgba(${Math.min(255,r+50)},${Math.min(255,g+50)},${Math.min(255,b+50)},${aC.toFixed(3)})`);
      gr.addColorStop(0.85, `rgba(${r},${g},${b},${(aC*0.80).toFixed(3)})`);
      gr.addColorStop(1,    `rgba(${r},${g},${b},${aE.toFixed(3)})`);
      return gr;
    }

    // Sine-wave proximity: how close is plasma to a given y position?
    // top half (plasma moves down): prox = (sin((y-offset)/BAND*2π)+1)/2
    // bot half (plasma moves up):   prox = (sin((H-y-offset)/BAND*2π)+1)/2
    function plasmaProx(ry, isTop) {
      const ph = isTop
        ? ((ry - offset) / BAND) * Math.PI * 2
        : ((H - ry - offset) / BAND) * Math.PI * 2;
      return Math.max(0, (Math.sin(ph) + 1) / 2);
    }

    // ── 1. PLASMA TUBE BASE FILLS ──
    ctx.save();
    ctx.beginPath(); ctx.rect(tubeX, 0, tubeW, midY); ctx.clip();
    const topBg = ctx.createLinearGradient(0, 0, 0, midY);
    topBg.addColorStop(0,    'rgba(32,2,2,0.96)');
    topBg.addColorStop(0.75, 'rgba(58,5,3,0.98)');
    topBg.addColorStop(1,    'rgba(20,3,2,0.25)');
    ctx.fillStyle = topBg; ctx.fillRect(tubeX, 0, tubeW, midY);
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(tubeX, midY, tubeW, midY); ctx.clip();
    const botBg = ctx.createLinearGradient(0, midY, 0, H);
    botBg.addColorStop(0,    'rgba(2,5,32,0.25)');
    botBg.addColorStop(0.25, 'rgba(3,8,65,0.98)');
    botBg.addColorStop(1,    'rgba(2,4,32,0.96)');
    ctx.fillStyle = botBg; ctx.fillRect(tubeX, midY, tubeW, midY);
    ctx.restore();

    // ── 2. PERSISTENT AMBIENT GLOW ──
    ctx.fillStyle = tGrad(195, 48, 8,  0.09, 0.02);
    ctx.fillRect(tubeX, 0, tubeW, midY);
    ctx.fillStyle = tGrad(8, 115, 215, 0.09, 0.02);
    ctx.fillRect(tubeX, midY, tubeW, midY);

    // ── 3. FLOWING PLASMA: TOP (red/orange → DOWN) ──
    ctx.save();
    ctx.beginPath(); ctx.rect(tubeX, 0, tubeW, midY - houseH / 2); ctx.clip();
    for (let i = 0; i < nBands; i++) {
      const y = (offset % BAND) + i * BAND - BAND;
      if (y < -20 || y > midY) continue;
      const fadeIn  = Math.max(0, Math.min(1, y / (BAND * 0.8)));
      const fadeOut = Math.max(0, Math.min(1, (midY - houseH / 2 - y) / (BAND * 1.0)));
      const a = fadeIn * fadeOut;
      if (a < 0.02) continue;
      ctx.fillStyle = tGrad(215, 68, 5,  a * 0.38, a * 0.07);
      ctx.fillRect(tubeX, y - 13, tubeW, 28);
      ctx.fillStyle = tGrad(240, 130, 16, a * 0.78, a * 0.16);
      ctx.fillRect(tubeX, y - 5,  tubeW, 11);
      ctx.fillStyle = tGrad(255, 218, 70, a * 0.94, a * 0.40);
      ctx.fillRect(tubeX, y - 1,  tubeW, 3);
    }
    ctx.restore();

    // ── 4. FLOWING PLASMA: BOTTOM (blue/cyan → UP) ──
    ctx.save();
    ctx.beginPath(); ctx.rect(tubeX, midY + houseH / 2, tubeW, midY - houseH / 2); ctx.clip();
    for (let i = 0; i < nBands; i++) {
      const y = H - (offset % BAND) - i * BAND + BAND;
      if (y < midY || y > H + 20) continue;
      const fadeIn  = Math.max(0, Math.min(1, (H - y) / (BAND * 0.8)));
      const fadeOut = Math.max(0, Math.min(1, (y - midY - houseH / 2) / (BAND * 1.0)));
      const a = fadeIn * fadeOut;
      if (a < 0.02) continue;
      ctx.fillStyle = tGrad(5, 135, 235, a * 0.38, a * 0.07);
      ctx.fillRect(tubeX, y - 13, tubeW, 28);
      ctx.fillStyle = tGrad(15, 175, 255, a * 0.78, a * 0.16);
      ctx.fillRect(tubeX, y - 5,  tubeW, 11);
      ctx.fillStyle = tGrad(115, 228, 255, a * 0.94, a * 0.40);
      ctx.fillRect(tubeX, y - 1,  tubeW, 3);
    }
    ctx.restore();

    // ── 5. STRUCTURAL RAILS (opaque over plasma) ──
    ctx.fillStyle = 'rgba(24,28,38,0.98)';
    ctx.fillRect(0, 0, railW, H);
    ctx.fillRect(W - railW, 0, railW, H);

    // Inner tube-wall highlight lines
    ctx.strokeStyle = 'rgba(72,100,145,0.48)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tubeX + 0.5, 0);     ctx.lineTo(tubeX + 0.5, H);
    ctx.moveTo(W - tubeX - 0.5, 0); ctx.lineTo(W - tubeX - 0.5, H);
    ctx.stroke();

    // ── 6. STATIC INJECTOR RINGS — illuminated by passing plasma ──
    const nIRings = Math.ceil(H / RING_GAP) + 1;
    const ringR   = Math.max(2.8, railW * 0.25);
    const ringCxL = railW * 0.50;
    const ringCxR = W - railW * 0.50;

    for (let i = 0; i <= nIRings; i++) {
      const ry = i * RING_GAP;
      if (ry < 0 || ry > H) continue;

      const isTopRing = ry < midY - houseH / 2;
      const isBotRing = ry > midY + houseH / 2;
      const inHousing = !isTopRing && !isBotRing;

      // Proximity glow: how close is the plasma to this ring?
      const prox = inHousing ? 0 : plasmaProx(ry, isTopRing);
      const baseA = inHousing ? 0.28 : 0.40;
      const glowA = baseA + prox * 0.55;

      // Structural connector bar across tube (darker fill = visible as solid ring)
      if (!inHousing) {
        // Dark structural "ring" bar
        ctx.fillStyle = `rgba(18,20,28,${(0.55 + prox * 0.10).toFixed(3)})`;
        ctx.fillRect(tubeX, ry - 2, tubeW, 4);
        // Colored edge line (illuminated by proximity)
        const edgeA = 0.25 + prox * 0.65;
        ctx.strokeStyle = isTopRing
          ? `rgba(200,80,20,${edgeA.toFixed(3)})`
          : `rgba(20,160,220,${edgeA.toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tubeX, ry); ctx.lineTo(W - tubeX, ry);
        ctx.stroke();
      }

      // Injector disc outer ring
      const discR  = isTopRing || inHousing ? [165, 55, 18] : [18, 135, 180];
      const discStr = `rgba(${discR[0]},${discR[1]},${discR[2]},${glowA.toFixed(3)})`;
      ctx.strokeStyle = discStr;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(ringCxL, ry, ringR, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(ringCxR, ry, ringR, 0, Math.PI * 2); ctx.stroke();

      // Disc fill
      ctx.fillStyle = `rgba(${discR[0]},${discR[1]},${discR[2]},${(glowA * 0.45).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(ringCxL, ry, ringR - 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ringCxR, ry, ringR - 0.5, 0, Math.PI * 2); ctx.fill();

      // Center dot — brightens with proximity
      const dotA = (inHousing ? 0.32 : 0.45) + prox * 0.52;
      ctx.fillStyle = `rgba(255,210,130,${dotA.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(ringCxL, ry, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ringCxR, ry, 1.2, 0, Math.PI * 2); ctx.fill();
    }

    // ── 7. REACTION CHAMBER HOUSING ──
    const hTop = midY - houseH / 2;
    const hBot = midY + houseH / 2;

    // Main housing fill
    ctx.fillStyle = 'rgba(16,20,30,0.99)';
    ctx.fillRect(0, hTop, W, houseH);

    // Edge highlights
    ctx.fillStyle = 'rgba(88,112,155,0.65)';
    ctx.fillRect(0, hTop,     W, 1);
    ctx.fillRect(0, hBot - 1, W, 1);
    // Secondary inner edges
    ctx.fillStyle = 'rgba(60,78,108,0.40)';
    ctx.fillRect(0, hTop + 3, W, 1);
    ctx.fillRect(0, hBot - 4, W, 1);

    // ── RAIL EFFLUX — vertical shimmer in side rail columns at housing level ──
    {
      const NUM_S = 5;
      for (const [rx, rw] of [[0, railW], [W - railW, railW]]) {
        ctx.save();
        ctx.beginPath(); ctx.rect(rx, hTop + 2, rw, houseH - 4); ctx.clip();

        for (let i = 0; i < NUM_S; i++) {
          const ph  = ((offset / BAND + i / NUM_S) % 1 + 1) % 1;
          const alp = Math.pow(1 - ph, 1.25) * 0.78 * pulse;
          if (alp < 0.01) continue;
          const sh = Math.max(1.5, (1 - ph) * 5.5);
          const sw = Math.max(2, Math.round((1 - ph) * (rw - 2)));
          const sx = rx + Math.round((rw - sw) / 2);

          ctx.fillStyle = `rgba(170,225,255,${alp.toFixed(3)})`;
          // upward streak from midY toward hTop
          ctx.fillRect(sx, midY - ph * (midY - hTop - 3) - sh, sw, sh);
          // downward streak from midY toward hBot
          ctx.fillRect(sx, midY + ph * (hBot - midY - 3),      sw, sh);
        }

        ctx.restore();
      }
    }

    // DILITHIUM CHAMBER — central circular element
    const chamR = Math.min(houseH / 2 - 6, Math.round(tubeW * 0.42));
    const chamX = W / 2;
    const chamY = midY;
    // Outer halo glow (behind everything)
    const chamHalo = ctx.createRadialGradient(chamX, chamY, chamR * 0.6, chamX, chamY, chamR * 2.0);
    chamHalo.addColorStop(0,  `rgba(100,180,255,${(0.28 * pulse).toFixed(3)})`);
    chamHalo.addColorStop(1,  'rgba(20,60,180,0)');
    ctx.fillStyle = chamHalo;
    ctx.beginPath(); ctx.arc(chamX, chamY, chamR * 2.0, 0, Math.PI * 2); ctx.fill();
    // Outer housing ring (thick)
    ctx.strokeStyle = `rgba(80,115,175,0.90)`;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(chamX, chamY, chamR, 0, Math.PI * 2); ctx.stroke();
    // Inner detail ring
    ctx.strokeStyle = `rgba(140,200,255,${(0.55 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1.0;
    ctx.beginPath(); ctx.arc(chamX, chamY, chamR * 0.68, 0, Math.PI * 2); ctx.stroke();
    // Crystal fill (radial gradient)
    const chamGr = ctx.createRadialGradient(chamX, chamY, 0, chamX, chamY, chamR);
    chamGr.addColorStop(0,   `rgba(255,255,255,${(0.90 * pulse).toFixed(3)})`);
    chamGr.addColorStop(0.25,`rgba(200,240,255,${(0.75 * pulse).toFixed(3)})`);
    chamGr.addColorStop(0.55,`rgba(80,170,240,${(0.45 * pulse).toFixed(3)})`);
    chamGr.addColorStop(0.85,`rgba(30,90,190,${(0.22 * pulse).toFixed(3)})`);
    chamGr.addColorStop(1,   'rgba(10,40,120,0)');
    ctx.fillStyle = chamGr;
    ctx.beginPath(); ctx.arc(chamX, chamY, chamR, 0, Math.PI * 2); ctx.fill();

    // ── HORIZONTAL PLASMA EFFLUX (emanating from chamber sides) ──
    const sideW = Math.max(0, tubeW / 2 - chamR - 3);
    if (sideW > 4) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(tubeX, hTop + 1, tubeW, houseH - 2);
      ctx.clip();

      // Ambient gradient glow — steady backdrop on each side
      for (const [gx0, gx1] of [[chamX - chamR, tubeX], [chamX + chamR, tubeX + tubeW]]) {
        const gr = ctx.createLinearGradient(gx0, 0, gx1, 0);
        const nearStop = `rgba(60,160,255,${(0.30 * pulse).toFixed(3)})`;
        gr.addColorStop(gx0 < gx1 ? 0 : 1, nearStop);
        gr.addColorStop(gx0 < gx1 ? 1 : 0, 'rgba(15,55,160,0)');
        ctx.fillStyle = gr;
        const lx = Math.min(gx0, gx1), lw = Math.abs(gx1 - gx0);
        ctx.fillRect(lx, hTop + 1, lw, houseH - 2);
      }

      // Moving shimmer streaks — cycle outward from the crystal
      const NUM_STREAKS = 6;
      for (let i = 0; i < NUM_STREAKS; i++) {
        const ph = ((offset / BAND + i / NUM_STREAKS) % 1 + 1) % 1;
        const dist  = ph * sideW;
        const alpha = Math.pow(1 - ph, 1.4) * 0.72 * pulse;
        if (alpha < 0.01) continue;
        const sh = Math.max(1, (1 - ph) * 4.5);
        const sw = Math.max(3, (1 - ph) * 13);
        // Spread streaks at different heights across housing
        const yOff = (i / (NUM_STREAKS - 1) - 0.5) * (houseH * 0.62);
        const sy   = midY + yOff - sh / 2;
        ctx.fillStyle = `rgba(130,210,255,${alpha.toFixed(3)})`;
        ctx.fillRect(chamX - chamR - dist - sw, sy, sw, sh);  // left
        ctx.fillRect(chamX + chamR + dist,       sy, sw, sh);  // right
      }

      ctx.restore();
    }

    // Side detail notches in housing
    const nW = Math.max(4, Math.round((tubeW / 2 - chamR - 4) * 0.7));
    if (nW > 2) {
      ctx.fillStyle = 'rgba(62,85,125,0.45)';
      ctx.fillRect(tubeX + 2,                          midY - 4, nW, 8);
      ctx.fillRect(tubeX + tubeW - 2 - nW,             midY - 4, nW, 8);
    }

    // ── 8. PLASMA GLOW BLEED THROUGH HOUSING ──
    const blG = ctx.createLinearGradient(0, hTop - 10, 0, hBot + 10);
    blG.addColorStop(0,    'rgba(255,90,15,0)');
    blG.addColorStop(0.30, `rgba(255,170,35,${(0.18 * pulse).toFixed(3)})`);
    blG.addColorStop(0.48, `rgba(255,240,160,${(0.28 * pulse).toFixed(3)})`);
    blG.addColorStop(0.5,  `rgba(255,255,255,${(0.10 * pulse).toFixed(3)})`);
    blG.addColorStop(0.52, `rgba(160,240,255,${(0.28 * pulse).toFixed(3)})`);
    blG.addColorStop(0.70, `rgba(35,170,255,${(0.18 * pulse).toFixed(3)})`);
    blG.addColorStop(1,    'rgba(8,50,255,0)');
    ctx.fillStyle = blG;
    ctx.fillRect(tubeX, hTop - 10, tubeW, houseH + 20);

    _animFrame = requestAnimationFrame(draw);
  }

  _animFrame = requestAnimationFrame(draw);
}

function getWarpRatio() {
  return Math.round(6 + _warpFuel * 0.26) + ':1';
}

function adjustWarpFuel(delta) {
  _warpFuel = Math.max(0, Math.min(100, _warpFuel + delta));
  localStorage.setItem('lcars-warp-fuel', _warpFuel);
  const d = document.getElementById('warp-ratio-display');
  if (d) d.textContent = getWarpRatio();
}

function activateWarpControls() {
  if (!_warpCtrlBtns.length) return;
  const [b0, b1, b2, b3] = _warpCtrlBtns;

  b0.textContent = 'M/ARC';
  b0.className   = 'lcars-rp-btn lcars-rp-warp-label';
  b0.onclick     = null;
  b0.style.removeProperty('--rp-shimmer');
  b0.style.removeProperty('--rp-delay');

  b1.id          = 'warp-ratio-display';
  b1.textContent = getWarpRatio();
  b1.className   = 'lcars-rp-btn lcars-rp-warp-ratio';
  b1.onclick     = null;
  b1.style.removeProperty('--rp-shimmer');
  b1.style.removeProperty('--rp-delay');

  b2.textContent = 'FUEL  +';
  b2.className   = 'lcars-rp-btn lcars-rp-func lcars-rp-warp-fuel-up';
  b2.onclick     = () => adjustWarpFuel(10);
  b2.style.removeProperty('--rp-shimmer');
  b2.style.removeProperty('--rp-delay');

  b3.textContent = 'FUEL  −';
  b3.className   = 'lcars-rp-btn lcars-rp-func lcars-rp-warp-fuel-dn';
  b3.onclick     = () => adjustWarpFuel(-10);
  b3.style.removeProperty('--rp-shimmer');
  b3.style.removeProperty('--rp-delay');
}

function deactivateWarpControls() {
  const decorStates = ['', '', '', 'rp-blue', 'rp-blue', 'rp-teal', 'rp-orange'];
  _warpCtrlBtns.forEach(btn => {
    const a = Math.floor(Math.random() * 89 + 10);
    const b = Math.floor(Math.random() * 899 + 100);
    btn.id        = '';
    btn.textContent = `${a}-${b}`;
    btn.className = 'lcars-rp-btn';
    const cls = decorStates[Math.floor(Math.random() * decorStates.length)];
    if (cls) btn.classList.add(cls);
    btn.style.setProperty('--rp-shimmer', (2.5 + Math.random() * 4).toFixed(1) + 's');
    btn.style.setProperty('--rp-delay',   (Math.random() * 4).toFixed(1) + 's');
    btn.onclick = null;
  });
}

function toggleViewMode(canvas, btn) {
  _viewMode = _viewMode === 'dna' ? 'warp' : 'dna';
  localStorage.setItem('lcars-view-mode', _viewMode);
  btn.textContent = _viewMode === 'warp' ? 'DNA HELIX' : 'WARP CORE';
  btn.classList.toggle('warp', _viewMode === 'warp');
  if (_viewMode === 'warp') { activateWarpControls(); startWarpCore(canvas); }
  else                      { deactivateWarpControls(); startHelix(canvas); }
}

// ─── Telemetry ─────────────────────────────────────────────────────

const _uptimeStart = Date.now();
let _contextPct = 0;

function computeStardate() {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const yearEnd   = new Date(now.getFullYear() + 1, 0, 1);
  const fraction  = (now - yearStart) / (yearEnd - yearStart);
  const base = 78000 + (now.getFullYear() - 2026) * 1000;
  return (base + fraction * 1000).toFixed(1);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

// ─── Token telemetry ──────────────────────────────────────────────

const CTX_LIMIT = 200000;

function updateTokenTelemetry(usage) {
  const inEl  = document.getElementById('telem-tokens-in');
  const outEl = document.getElementById('telem-tokens-out');
  if (!inEl || !outEl) return;

  const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  const inTok = (usage.input_tokens || 0) + (usage.cache_read || 0);
  inEl.textContent  = fmt(inTok);
  outEl.textContent = fmt(usage.output_tokens || 0);

  const pct = inTok / CTX_LIMIT;
  _contextPct = pct * 100;
  const warn = document.getElementById('context-warning');

  if (pct >= 0.90) {
    inEl.style.color = 'var(--lp-alert)';
    if (warn) {
      warn.style.display = 'flex';
      warn.className = 'lcars-context-warning warn-red';
      warn.textContent = `⚠ CONTEXT CRITICAL — ${Math.round(pct * 100)}% of limit used (${fmt(inTok)} / ${fmt(CTX_LIMIT)} tokens) — start a new session soon`;
    }
  } else if (pct >= 0.75) {
    inEl.style.color = 'var(--lp-warn)';
    if (warn) {
      warn.style.display = 'flex';
      warn.className = 'lcars-context-warning warn-amber';
      warn.textContent = `⚠ CONTEXT LIMIT — ${Math.round(pct * 100)}% of limit used (${fmt(inTok)} / ${fmt(CTX_LIMIT)} tokens)`;
    }
  } else {
    inEl.style.color = '';
    if (warn) warn.style.display = 'none';
    // Flash cyan only when normal
    inEl.style.color = 'var(--lp-cyan)';
    setTimeout(() => { inEl.style.color = ''; }, 2000);
  }

  outEl.style.color = 'var(--lp-cyan)';
  setTimeout(() => { outEl.style.color = ''; }, 2000);
}

// ─── Footer animated bars ─────────────────────────────────────────

function initFooterBars() {
  // bars[0]=NEURAL LOAD(cpu), bars[1]=POWER GRID(ram), bars[2]=SENSOR ARRAY(animated)
  const bars = [
    { fill: document.getElementById('fbar-temp'),   val: document.getElementById('fbar-temp-val'),   current: 30, target: 30, real: true,  key: 'cpu' },
    { fill: document.getElementById('fbar-power'),  val: document.getElementById('fbar-power-val'),  current: 50, target: 50, real: true,  key: 'ram' },
    { fill: document.getElementById('fbar-sensor'), val: document.getElementById('fbar-sensor-val'), current: 25 + Math.random() * 50, target: 45, real: false, next: 0 },
  ];

  function tick() {
    const now = Date.now();
    bars.forEach(bar => {
      if (bar.real) {
        bar.target = _metricsBarTargets[bar.key] ?? bar.target;
      } else {
        if (now > bar.next) {
          bar.target = 15 + Math.random() * 78;
          bar.next = now + 5000 + Math.random() * 10000;
        }
      }
      bar.current += (bar.target - bar.current) * 0.04;
      const pct = Math.min(100, Math.max(0, bar.current));
      if (bar.fill) {
        bar.fill.style.width = pct + '%';
        bar.fill.style.background =
          pct >= 88 ? 'var(--lp-alert)' :
          pct >= 72 ? 'var(--lp-warn)'  :
                      'var(--lp-blue)';
      }
      if (bar.val) bar.val.textContent = Math.round(pct) + '%';
    });
    requestAnimationFrame(tick);
  }
  tick();
}

async function pollMetrics() {
  try {
    const r = await fetch('/api/metrics');
    if (r.ok) {
      const d = await r.json();
      _metricsBarTargets.cpu = d.cpu_pct ?? _metricsBarTargets.cpu;
      _metricsBarTargets.ram = d.mem_pct ?? _metricsBarTargets.ram;
    }
  } catch {}
  setTimeout(pollMetrics, 5000);
}

// ─── Header data grid ─────────────────────────────────────────────

function initDataGrid() {
  const grid = document.getElementById('data-grid');
  if (!grid) return;

  const ROWS = 4;
  const COL_GEN = [
    () => String(Math.floor(Math.random() * 9900) + 10),
    () => String(Math.floor(Math.random() * 90000) + 10000),
    () => (Math.floor(Math.random() * 90) + 10).toFixed(3),
    () => String(Math.floor(Math.random() * 9000) + 10),
    () => `${Math.floor(Math.random()*900)+10}/${Math.floor(Math.random()*9000)+10}`,
    () => String(Math.floor(Math.random() * 90000) + 10000),
  ];

  const DOT_COLORS = ['#3a9fdb', '#20b8a8', '#d84848', '#707880'];
  const COLOR_CLASSES = ['dg-bright', 'dg-blue', 'dg-teal', 'dg-red', 'dg-dim'];

  function pickColor() {
    const r = Math.random();
    if (r < 0.15) return 'dg-bright';
    if (r < 0.30) return 'dg-blue';
    if (r < 0.38) return 'dg-teal';
    if (r < 0.46) return 'dg-red';
    return 'dg-dim';
  }

  const cells = [];

  for (let r = 0; r < ROWS; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'lcars-dg-row';

    for (let c = 0; c < COL_GEN.length; c++) {
      const cellEl = document.createElement('div');
      cellEl.className = 'lcars-dg-cell';

      if (c === 0) {
        const numEl = document.createElement('span');
        numEl.className = 'lcars-dg-num lcars-dg-lead-num';
        numEl.textContent = COL_GEN[0]();

        const dotEl = document.createElement('span');
        dotEl.className = 'lcars-dg-dot';
        dotEl.style.background = DOT_COLORS[Math.floor(Math.random() * DOT_COLORS.length)];

        cellEl.appendChild(numEl);
        cellEl.appendChild(dotEl);
        cells.push({ numEl, dotEl, gen: COL_GEN[0], col: 0 });
      } else {
        const numEl = document.createElement('span');
        numEl.className = 'lcars-dg-num';
        numEl.classList.add(pickColor());
        numEl.textContent = COL_GEN[c]();
        cellEl.appendChild(numEl);
        cells.push({ numEl, dotEl: null, gen: COL_GEN[c], col: c });
      }

      rowEl.appendChild(cellEl);
    }
    grid.appendChild(rowEl);
  }

  function tick() {
    const count = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
      const cell = cells[Math.floor(Math.random() * cells.length)];
      cell.numEl.textContent = cell.gen();
      if (cell.col === 0) {
        cell.dotEl.style.background = DOT_COLORS[Math.floor(Math.random() * DOT_COLORS.length)];
      } else {
        cell.numEl.classList.remove(...COLOR_CLASSES);
        cell.numEl.classList.add(pickColor());
      }
    }
    setTimeout(tick, 120 + Math.random() * 380);
  }
  tick();
}

function initTelemetry() {
  function tick() {
    const sd = computeStardate();

    const sdEl = document.getElementById('telem-stardate');
    if (sdEl) sdEl.textContent = sd;


    const uptimeEl = document.getElementById('telem-uptime');
    if (uptimeEl) uptimeEl.textContent = formatUptime(Date.now() - _uptimeStart);

    const ctxEl = document.getElementById('telem-context');
    if (ctxEl) {
      if (_contextPct > 0) {
        ctxEl.textContent = _contextPct.toFixed(1) + '%';
        ctxEl.className = 'lcars-telem-value' +
          (_contextPct >= 90 ? ' alert' : _contextPct >= 75 ? ' warn' : '');
      } else {
        ctxEl.textContent = '—';
        ctxEl.className = 'lcars-telem-value';
      }
    }
  }

  tick();
  setInterval(tick, 1000);
}

// ─── Start ─────────────────────────────────────────────────────────

init();
