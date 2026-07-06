// ===== Constants =====
const KEYS_KEY = 'mini-ai-chat-api-keys';
const PROMPT_KEY = 'mini-ai-chat-system-prompt';
const MODELS_KEY = 'mini-ai-chat-custom-models';
const DEFAULT_PROMPT = 'You are a helpful assistant. Answer this: ${input}';
const BUILTIN_MODELS = ['llama3-8b-8192', 'llama3-70b-8192', 'mixtral-8x7b-32768', 'gemma2-9b-it'];
const EMPTY_KEYS = { groq: '' };

// ===== State =====
let conversations = [];
let activeId = '';
let apiKeys = { ...EMPTY_KEYS };
let systemPrompt = DEFAULT_PROMPT;
let customModels = [];
let currentModel = BUILTIN_MODELS[0];
let msgId = 0;
let settingsOpen = false;
let atBottom = true;
let isGenerating = false;

// ===== DOM refs =====
const els = {};

function cacheEls() {
  els.app = document.getElementById('app');
  els.sidebar = document.getElementById('sidebar');
  els.sidebarContent = document.getElementById('sidebar-content');
  els.pinnedSection = document.getElementById('pinned-section');
  els.pinnedList = document.getElementById('pinned-list');
  els.recentList = document.getElementById('recent-list');
  els.emptyRecent = document.getElementById('empty-recent');
  els.activeTitle = document.getElementById('active-title');
  els.btnNewChat = document.getElementById('btn-new-chat');
  els.btnSettings = document.getElementById('btn-settings');
  els.chatScroll = document.getElementById('chat-scroll');
  els.chatEmpty = document.getElementById('chat-empty');
  els.chatMessages = document.getElementById('chat-messages');
  els.scrollBottom = document.getElementById('scroll-bottom');
  els.btnScrollBottom = document.getElementById('scroll-to-bottom');
  els.chatInput = document.getElementById('chat-input');
  els.btnSend = document.getElementById('btn-send');
  els.modelSelectWrapper = document.getElementById('model-select-wrapper');
  els.modelSelectBtn = document.getElementById('model-select-btn');
  els.modelSelectLabel = document.getElementById('model-select-label');
  els.modelDropdown = document.getElementById('model-dropdown');
  // Settings modal
  els.settingsModal = document.getElementById('settings-modal');
  els.modalBackdrop = document.getElementById('modal-backdrop');
  els.modalClose = document.getElementById('modal-close');
  els.keyGroq = document.getElementById('key-groq');
  els.modelFetchedSelect = document.getElementById('model-fetched-select');
  els.btnAddModel = document.getElementById('btn-add-model');
  els.modelList = document.getElementById('model-list');
  els.modelEmpty = document.getElementById('model-empty');
  els.systemPrompt = document.getElementById('system-prompt');
  els.btnSaveSettings = document.getElementById('btn-save-settings');
  els.saveText = document.getElementById('save-text');
  els.saveCheck = document.getElementById('save-check');
}

// ===== Utilities =====
function createId() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function createConversation() {
  return { id: createId(), title: 'New chat', messages: [], pinned: false };
}

async function fetchModelsFromGroq(apiKey) {
  const response = await fetch('https://api.groq.com/openai/v1/models', {
    headers: {
      'Authorization': `Bearer ${apiKey}`
    }
  });
  if (!response.ok) {
    throw new Error('Failed to fetch models from Groq API');
  }
  const data = await response.json();
  return data.data ? data.data.map(m => m.id) : [];
}

async function checkAndFetchModels() {
  const key = els.keyGroq.value.trim();
  if (!key) {
    els.modelFetchedSelect.disabled = true;
    els.modelFetchedSelect.innerHTML = '<option value="">Enter Groq API Key to fetch models...</option>';
    els.btnAddModel.disabled = true;
    return;
  }

  els.modelFetchedSelect.innerHTML = '<option value="">Fetching available models...</option>';
  els.modelFetchedSelect.disabled = true;
  els.btnAddModel.disabled = true;

  try {
    const models = await fetchModelsFromGroq(key);
    if (models.length === 0) {
      els.modelFetchedSelect.innerHTML = '<option value="">No models found</option>';
      return;
    }

    els.modelFetchedSelect.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    els.modelFetchedSelect.disabled = false;
    els.btnAddModel.disabled = false;
  } catch (err) {
    console.error(err);
    els.modelFetchedSelect.innerHTML = `<option value="">Error: Could not load models</option>`;
  }
}

async function generateChatTitle(userPrompt) {
  try {
    const apiKey = apiKeys.groq;
    if (!apiKey) return;
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: currentModel,
        messages: [
          { role: 'system', content: 'Generate a short, concise chat title (2-4 words maximum, no quotes, no punctuation) based on the user prompt. Do not prefix with "Title:".' },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 10
      })
    });
    if (response.ok) {
      const data = await response.json();
      const title = data?.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '');
      if (title) {
        const active = conversations.find(c => c.id === activeId);
        if (active) {
          active.title = title;
          renderSidebar();
          els.activeTitle.textContent = title;
        }
      }
    }
  } catch (e) {
    console.error("Failed to generate title", e);
  }
}

async function fetchCompletionStream(messages, modelName, onChunk) {
  const apiKey = apiKeys.groq;
  if (!apiKey) {
    throw new Error(`Groq API key is missing. Please configure it in Settings.`);
  }

  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  const apiMessages = [];
  let sysPrompt = systemPrompt.trim();
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (sysPrompt) {
    if (sysPrompt.includes('${input}') && lastUser) {
      sysPrompt = sysPrompt.replaceAll('${input}', lastUser.content);
    }
    apiMessages.push({ role: 'system', content: sysPrompt });
  }

  messages.forEach(m => {
    if (!m.error) {
      apiMessages.push({ role: m.role, content: m.content });
    }
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      model: modelName,
      messages: apiMessages,
      stream: true
    })
  });

  if (!response.ok) {
    let errorText = '';
    try {
      const errorJson = await response.json();
      errorText = errorJson?.error?.message || response.statusText;
    } catch {
      errorText = `HTTP Error ${response.status}: ${response.statusText}`;
    }
    throw new Error(errorText);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const cleanLine = line.trim();
      if (!cleanLine) continue;
      if (cleanLine === 'data: [DONE]') continue;
      if (cleanLine.startsWith('data: ')) {
        try {
          const json = JSON.parse(cleanLine.substring(6));
          const text = json.choices?.[0]?.delta?.content || '';
          if (text) {
            onChunk(text);
          }
        } catch (e) {
          // Ignore partial parse failures
        }
      }
    }
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

// ===== Storage =====
function loadStorage() {
  try {
    const storedKeys = localStorage.getItem(KEYS_KEY);
    if (storedKeys) apiKeys = { ...EMPTY_KEYS, ...JSON.parse(storedKeys) };
    const storedModels = localStorage.getItem(MODELS_KEY);
    if (storedModels) customModels = JSON.parse(storedModels);
  } catch { /* ignore */ }
  systemPrompt = localStorage.getItem(PROMPT_KEY) || DEFAULT_PROMPT;
}

function saveStorage() {
  localStorage.setItem(KEYS_KEY, JSON.stringify(apiKeys));
  localStorage.setItem(PROMPT_KEY, systemPrompt);
  localStorage.setItem(MODELS_KEY, JSON.stringify(customModels));
}

// ===== Rendering =====
function renderSidebar() {
  const pinned = conversations.filter(c => c.pinned);
  const recent = conversations.filter(c => !c.pinned);

  // Pinned
  if (pinned.length === 0) {
    els.pinnedSection.classList.add('hidden');
  } else {
    els.pinnedSection.classList.remove('hidden');
    els.pinnedList.innerHTML = pinned.map(c => renderChatRow(c)).join('');
  }

  // Recent
  if (recent.length === 0) {
    els.recentList.classList.add('hidden');
    els.emptyRecent.classList.remove('hidden');
  } else {
    els.recentList.classList.remove('hidden');
    els.emptyRecent.classList.add('hidden');
    els.recentList.innerHTML = recent.map(c => renderChatRow(c)).join('');
  }
}

function renderChatRow(chat) {
  const isActive = chat.id === activeId;
  const pinLabel = chat.pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`;
  const pinIcon = chat.pinned
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>';

  return `
    <li class="chat-row ${isActive ? 'active' : ''}" data-id="${chat.id}">
      <button type="button" class="chat-row-btn" onclick="selectChat('${chat.id}')" ondblclick="startRename('${chat.id}')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
        <span class="chat-row-title">${escapeHtml(chat.title)}</span>
      </button>
      <div class="chat-row-actions">
        <button type="button" class="btn-row-action" onclick="startRename('${chat.id}')" aria-label="Rename ${chat.title}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
        </button>
        <button type="button" class="btn-row-action ${chat.pinned ? 'pinned' : ''}" onclick="togglePin('${chat.id}')" aria-label="${pinLabel}">
          ${pinIcon}
        </button>
        <button type="button" class="btn-row-action btn-delete" onclick="deleteChat('${chat.id}')" aria-label="Delete ${chat.title}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    </li>
  `;
}

function renderMessages() {
  const active = conversations.find(c => c.id === activeId) || conversations[0];
  if (!active) return;

  els.activeTitle.textContent = active.title;

  if (active.messages.length === 0 && !isGenerating) {
    els.chatEmpty.classList.remove('hidden');
    els.chatMessages.classList.add('hidden');
    els.btnScrollBottom.classList.add('hidden');
    return;
  }

  els.chatEmpty.classList.add('hidden');
  els.chatMessages.classList.remove('hidden');

  const lastAssistantId = [...active.messages].reverse().find(m => m.role === 'assistant')?.id;
  const lastMsg = active.messages[active.messages.length - 1];

  let messagesHtml = active.messages.map(m => {
    const isUser = m.role === 'user';
    const isLastAssistant = m.id === lastAssistantId;
    const isError = m.error;
    const isStreaming = isGenerating && isLastAssistant;
    const bubbleClass = isUser ? 'user' : (isError ? 'assistant error' : (isStreaming ? 'assistant streaming-cursor' : 'assistant'));
    const contentHtml = isUser
      ? `<p>${escapeHtml(m.content)}</p>`
      : renderMarkdown(m.content);

    const actions = (isUser || isError || isStreaming) ? '' : renderMessageActions(m, isLastAssistant);

    return `
      <div class="msg-group ${m.role}">
        <div class="msg-bubble ${bubbleClass}">${contentHtml}</div>
        ${actions}
      </div>
    `;
  }).join('');

  if (isGenerating && (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.content)) {
    messagesHtml += `
      <div class="msg-group assistant">
        <div class="msg-bubble assistant">
          <div class="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>
    `;
  }

  els.chatMessages.innerHTML = messagesHtml + '<div id="scroll-bottom"></div>';
}

function renderMarkdown(content) {
  if (typeof marked !== 'undefined') {
    try {
      return marked.parse(content, { breaks: true });
    } catch {
      return escapeHtml(content).replace(/\n/g, '<br>');
    }
  }
  return escapeHtml(content).replace(/\n/g, '<br>');
}

function renderMessageActions(msg, canRegenerate) {
  return `
    <div class="msg-actions">
      <button type="button" class="btn-msg-action" onclick="copyMessage(${msg.id})" aria-label="Copy message" title="Copy response">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      </button>
      ${canRegenerate ? `
        <button type="button" class="btn-msg-action" onclick="regenerate()" aria-label="Retry response" title="Retry">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
        </button>
      ` : ''}
    </div>
  `;
}

function renderModelSelect() {
  if (customModels.length === 0) {
    els.modelSelectLabel.textContent = 'Choose a model in Settings';
    currentModel = '';
    els.modelDropdown.innerHTML = '<div class="model-dropdown-empty">No models pinned yet</div>';
  } else {
    if (!customModels.includes(currentModel)) {
      currentModel = customModels[0];
    }
    els.modelSelectLabel.textContent = currentModel;
    els.modelDropdown.innerHTML = customModels.map(m => {
      const activeClass = m === currentModel ? 'active' : '';
      return `<button type="button" class="model-dropdown-item ${activeClass}" data-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`;
    }).join('');
  }
}

function toggleModelDropdown() {
  const isOpen = !els.modelDropdown.classList.contains('hidden');
  if (isOpen) {
    closeModelDropdown();
  } else {
    renderModelSelect();
    els.modelDropdown.classList.remove('hidden');
    els.modelSelectWrapper.classList.add('open');
  }
}

function closeModelDropdown() {
  els.modelDropdown.classList.add('hidden');
  els.modelSelectWrapper.classList.remove('open');
}

function selectModel(modelName) {
  currentModel = modelName;
  els.modelSelectLabel.textContent = modelName;
  closeModelDropdown();
  renderModelSelect();
}

function renderSettingsModels() {
  if (customModels.length === 0) {
    els.modelList.classList.add('hidden');
    els.modelEmpty.classList.remove('hidden');
  } else {
    els.modelList.classList.remove('hidden');
    els.modelEmpty.classList.add('hidden');
    els.modelList.innerHTML = customModels.map(name => `
      <li class="model-item">
        <span class="model-name">${escapeHtml(name)}</span>
        <button type="button" class="btn-remove-model" onclick="removeModel('${escapeHtml(name)}')" aria-label="Remove ${escapeHtml(name)}">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </li>
    `).join('');
  }
}

// ===== Scroll =====
function scrollToBottom(behavior = 'smooth') {
  const bottom = els.chatScroll.querySelector('#scroll-bottom');
  if (bottom) bottom.scrollIntoView({ behavior });
}

function handleScroll() {
  const el = els.chatScroll;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  atBottom = distance < 80;
  if (atBottom || conversations.find(c => c.id === activeId)?.messages.length === 0) {
    els.btnScrollBottom.classList.add('hidden');
  } else {
    els.btnScrollBottom.classList.remove('hidden');
  }
}

// ===== Actions =====
function selectChat(id) {
  activeId = id;
  renderSidebar();
  renderMessages();
  atBottom = true;
  els.btnScrollBottom.classList.add('hidden');
  setTimeout(() => scrollToBottom('auto'), 0);
}

function newChat() {
  const conv = createConversation();
  conversations.unshift(conv);
  activeId = conv.id;
  renderSidebar();
  renderMessages();
  atBottom = true;
  els.btnScrollBottom.classList.add('hidden');
}

function deleteChat(id) {
  const idx = conversations.findIndex(c => c.id === id);
  if (idx === -1) return;
  conversations.splice(idx, 1);

  if (conversations.length === 0) {
    const conv = createConversation();
    conversations.push(conv);
    activeId = conv.id;
  } else if (id === activeId) {
    activeId = conversations[0].id;
  }
  renderSidebar();
  renderMessages();
}

function togglePin(id) {
  const chat = conversations.find(c => c.id === id);
  if (chat) chat.pinned = !chat.pinned;
  // Re-sort: pinned first
  conversations.sort((a, b) => {
    if (a.pinned === b.pinned) return 0;
    return a.pinned ? -1 : 1;
  });
  renderSidebar();
}

function startRename(id) {
  const chat = conversations.find(c => c.id === id);
  if (!chat) return;

  // Find the row and replace with input
  const row = document.querySelector(`.chat-row[data-id="${id}"]`);
  if (!row) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'rename-wrapper';
  wrapper.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
    <input type="text" class="rename-input" value="${escapeHtml(chat.title)}" />
  `;

  const input = wrapper.querySelector('input');
  input.addEventListener('blur', () => commitRename(id, input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename(id, input.value);
    } else if (e.key === 'Escape') {
      renderSidebar();
    }
  });

  row.replaceWith(wrapper);
  input.focus();
  input.select();
}

function commitRename(id, title) {
  const trimmed = title.trim();
  const chat = conversations.find(c => c.id === id);
  if (trimmed && chat && trimmed !== chat.title) {
    chat.title = trimmed;
  }
  renderSidebar();
  if (id === activeId) els.activeTitle.textContent = chat?.title || 'New chat';
}

async function sendMessage() {
  const text = els.chatInput.value.trim();
  if (!text || isGenerating || !currentModel) return;

  const userMsg = { id: msgId++, role: 'user', content: text };
  const active = conversations.find(c => c.id === activeId);
  const isFirstMessage = active && active.messages.length === 0;
  if (active) {
    active.messages.push(userMsg);
  }

  els.chatInput.value = '';
  els.chatInput.style.height = 'auto';
  els.btnSend.disabled = true;
  isGenerating = true;

  if (isFirstMessage) {
    generateChatTitle(text);
  }

  renderSidebar();
  renderMessages();
  atBottom = true;
  setTimeout(() => scrollToBottom(), 0);

  const replyMsg = { id: msgId++, role: 'assistant', content: '' };
  if (active) {
    active.messages.push(replyMsg);
  }

  try {
    await fetchCompletionStream(
      active ? active.messages.slice(0, -1) : [userMsg],
      currentModel,
      (chunk) => {
        replyMsg.content += chunk;
        renderMessages();
        if (atBottom) scrollToBottom('auto');
      }
    );
  } catch (err) {
    console.error(err);
    replyMsg.content = `Error: ${err.message}`;
    replyMsg.error = true;
    renderMessages();
  } finally {
    isGenerating = false;
    renderMessages();
    atBottom = true;
    setTimeout(() => scrollToBottom(), 0);
  }
}

async function regenerate() {
  const active = conversations.find(c => c.id === activeId);
  if (!active || isGenerating) return;
  const lastUser = [...active.messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return;

  const msgs = active.messages;
  if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') msgs.pop();

  isGenerating = true;
  renderMessages();
  atBottom = true;
  setTimeout(() => scrollToBottom(), 0);

  const replyMsg = { id: msgId++, role: 'assistant', content: '' };
  msgs.push(replyMsg);

  try {
    await fetchCompletionStream(
      active.messages.slice(0, -1),
      currentModel,
      (chunk) => {
        replyMsg.content += chunk;
        renderMessages();
        if (atBottom) scrollToBottom('auto');
      }
    );
  } catch (err) {
    console.error(err);
    replyMsg.content = `Error: ${err.message}`;
    replyMsg.error = true;
    renderMessages();
  } finally {
    isGenerating = false;
    renderMessages();
    atBottom = true;
    setTimeout(() => scrollToBottom(), 0);
  }
}

function copyMessage(msgId) {
  const active = conversations.find(c => c.id === activeId);
  const msg = active?.messages.find(m => m.id === msgId);
  if (msg) {
    navigator.clipboard.writeText(msg.content).then(() => {
      // Show brief feedback
      const btn = document.activeElement;
      if (btn) {
        const original = btn.innerHTML;
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => btn.innerHTML = original, 1500);
      }
    });
  }
}

// ===== Settings =====
function openSettings() {
  settingsOpen = true;
  els.settingsModal.classList.remove('hidden');
  els.keyGroq.value = apiKeys.groq;
  els.systemPrompt.value = systemPrompt;
  renderSettingsModels();
  checkAndFetchModels();
  els.saveText.classList.remove('hidden');
  els.saveCheck.classList.add('hidden');
}

function closeSettings() {
  settingsOpen = false;
  els.settingsModal.classList.add('hidden');
}

function saveSettings() {
  apiKeys = {
    groq: els.keyGroq.value.trim()
  };
  systemPrompt = els.systemPrompt.value;
  saveStorage();

  els.saveText.classList.add('hidden');
  els.saveCheck.classList.remove('hidden');
  setTimeout(() => {
    if (settingsOpen) {
      els.saveText.classList.remove('hidden');
      els.saveCheck.classList.add('hidden');
    }
  }, 2000);
}

function addModel() {
  const name = els.modelFetchedSelect.value;
  if (!name || customModels.includes(name)) {
    return;
  }
  customModels.push(name);
  saveStorage();
  renderSettingsModels();
  renderModelSelect();
}

function removeModel(name) {
  customModels = customModels.filter(m => m !== name);
  saveStorage();
  renderSettingsModels();
  renderModelSelect();
}

function bindEvents() {
  els.btnNewChat.addEventListener('click', newChat);
  els.btnSettings.addEventListener('click', openSettings);
  els.modalBackdrop.addEventListener('click', closeSettings);
  els.modalClose.addEventListener('click', closeSettings);
  els.btnSaveSettings.addEventListener('click', saveSettings);
  els.btnAddModel.addEventListener('click', addModel);

  els.keyGroq.addEventListener('input', () => {
    const key = els.keyGroq.value.trim();
    if (key.length > 10) {
      checkAndFetchModels();
    } else {
      els.modelFetchedSelect.disabled = true;
      els.modelFetchedSelect.innerHTML = '<option value="">Enter Groq API Key to fetch models...</option>';
      els.btnAddModel.disabled = true;
    }
  });

  els.chatInput.addEventListener('input', () => {
    els.btnSend.disabled = !currentModel || !els.chatInput.value.trim();
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 160) + 'px';
  });

  els.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (currentModel) {
        sendMessage();
      }
    }
  });

  els.btnSend.addEventListener('click', sendMessage);

  // Custom model dropdown
  els.modelSelectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelDropdown();
  });
  els.modelDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.model-dropdown-item');
    if (item) {
      selectModel(item.dataset.model);
    }
  });
  document.addEventListener('click', (e) => {
    if (!els.modelSelectWrapper.contains(e.target)) {
      closeModelDropdown();
    }
  });

  els.chatScroll.addEventListener('scroll', handleScroll);
  els.btnScrollBottom.addEventListener('click', () => scrollToBottom());

  // Password visibility toggles
  document.querySelectorAll('.btn-toggle-eye').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      const eye = btn.querySelector('.icon-eye');
      const eyeOff = btn.querySelector('.icon-eye-off');
      if (input.type === 'password') {
        input.type = 'text';
        eye.classList.add('hidden');
        eyeOff.classList.remove('hidden');
      } else {
        input.type = 'password';
        eye.classList.remove('hidden');
        eyeOff.classList.add('hidden');
      }
    });
  });

  // Close modal on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && settingsOpen) closeSettings();
  });
}

// ===== Init =====
function init() {
  cacheEls();
  loadStorage();

  // Init conversations
  conversations = [createConversation()];
  activeId = conversations[0].id;

  renderSidebar();
  renderMessages();
  renderModelSelect();
  bindEvents();
}

// Expose functions to window for inline onclick handlers
window.selectChat = selectChat;
window.newChat = newChat;
window.deleteChat = deleteChat;
window.togglePin = togglePin;
window.startRename = startRename;
window.regenerate = regenerate;
window.copyMessage = copyMessage;
window.removeModel = removeModel;

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
