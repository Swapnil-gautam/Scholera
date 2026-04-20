/* ===== State ===== */
const state = {
  courses: [],
  currentCourseId: null,
  currentSessionId: null,
  mode: "rag", // "rag" | "raw"
  materials: [],
  sessions: [],
  sending: false,
};

/* ===== DOM refs ===== */
const $courseSelect   = document.getElementById("course-select");
const $chatMessages   = document.getElementById("chat-messages");
const $welcomeScreen  = document.getElementById("welcome-screen");
const $chatForm       = document.getElementById("chat-form");
const $chatInput      = document.getElementById("chat-input");
const $btnSend        = document.getElementById("btn-send");
const $btnNewChat     = document.getElementById("btn-new-chat");
const $btnUpload      = document.getElementById("btn-upload");
const $btnCreateCourse = document.getElementById("btn-create-course");
const $materialsList  = document.getElementById("materials-list");
const $chatHistory    = document.getElementById("chat-history");
const $courseStats     = document.getElementById("course-stats");
const $typingIndicator = document.getElementById("typing-indicator");
const $modeButtons    = document.querySelectorAll(".mode-btn");

/* ===== Init ===== */
document.addEventListener("DOMContentLoaded", async () => {
  await loadCourses();
  setupEventListeners();
});

function setupEventListeners() {
  $courseSelect.addEventListener("change", onCourseChange);
  $chatForm.addEventListener("submit", onSendMessage);
  $chatInput.addEventListener("input", onInputChange);
  $chatInput.addEventListener("keydown", onInputKeydown);
  $btnNewChat.addEventListener("click", onNewChat);
  $btnUpload.addEventListener("click", () => openModal("upload-modal"));
  $btnCreateCourse.addEventListener("click", () => openModal("course-modal"));

  $modeButtons.forEach(btn => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

  document.getElementById("course-form").addEventListener("submit", onCreateCourse);
  document.getElementById("upload-form").addEventListener("submit", onUploadMaterial);
  document.getElementById("btn-study-guide").addEventListener("click", () => {
    if (!state.currentCourseId) { alert("Please select a course first."); return; }
    openModal("study-modal");
  });
  document.getElementById("study-form").addEventListener("submit", onGenerateStudyGuide);

  document.getElementById("btn-audio-overview").addEventListener("click", () => {
    if (!state.currentCourseId) { alert("Please select a course first."); return; }
    openModal("audio-modal");
  });
  document.getElementById("audio-form").addEventListener("submit", onGenerateAudioOverview);

  // File drop zone
  const $fileDrop = document.getElementById("file-drop");
  const $fileInput = document.getElementById("file-input");
  $fileDrop.addEventListener("click", () => $fileInput.click());
  $fileDrop.addEventListener("dragover", e => { e.preventDefault(); $fileDrop.classList.add("dragover"); });
  $fileDrop.addEventListener("dragleave", () => $fileDrop.classList.remove("dragover"));
  $fileDrop.addEventListener("drop", e => {
    e.preventDefault();
    $fileDrop.classList.remove("dragover");
    if (e.dataTransfer.files.length) {
      $fileInput.files = e.dataTransfer.files;
      showFileName();
    }
  });
  $fileInput.addEventListener("change", showFileName);

  // Close modals on backdrop click
  document.querySelectorAll(".modal-backdrop").forEach(b =>
    b.addEventListener("click", () => b.parentElement.classList.add("hidden"))
  );
}

/* ===== API helpers ===== */
async function api(method, url, body = null) {
  const opts = { method, headers: {} };
  if (body && !(body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || JSON.stringify(data));
  return data;
}

/* ===== Courses ===== */
async function loadCourses() {
  state.courses = await api("GET", "/courses/");
  renderCourseSelect();
}

function renderCourseSelect() {
  const opts = state.courses.map(c =>
    `<option value="${c.id}">${c.title}</option>`
  ).join("");
  $courseSelect.innerHTML = `<option value="">-- Select a course --</option>${opts}`;
  if (state.currentCourseId) $courseSelect.value = state.currentCourseId;
}

async function onCourseChange() {
  state.currentCourseId = $courseSelect.value || null;
  state.currentSessionId = null;
  await Promise.all([loadMaterials(), loadChatHistory(), loadStats()]);
  clearChatDisplay();
}

async function onCreateCourse(e) {
  e.preventDefault();
  const title = document.getElementById("course-title").value.trim();
  const desc = document.getElementById("course-desc").value.trim();
  if (!title) return;
  const course = await api("POST", "/courses/", { title, description: desc });
  closeModal("course-modal");
  document.getElementById("course-title").value = "";
  document.getElementById("course-desc").value = "";
  await loadCourses();
  $courseSelect.value = course.id;
  await onCourseChange();
}

/* ===== Materials ===== */
async function loadMaterials() {
  if (!state.currentCourseId) { $materialsList.innerHTML = ""; return; }
  state.materials = await api("GET", `/courses/${state.currentCourseId}/materials/`);
  renderMaterials();
}

function renderMaterials() {
  if (!state.materials.length) {
    $materialsList.innerHTML = `<p style="font-size:12px;color:var(--text-muted);padding:4px;">No materials uploaded yet.</p>`;
    return;
  }
  $materialsList.innerHTML = state.materials.map(m => {
    const rawStatus = m.status || "pending";
    const parts = rawStatus.split("|");
    const mainStatus = parts[0];
    const step = parts[1] || "";
    const pct = parts[2] || "";
    const isProcessing = mainStatus === "processing";

    let statusHtml;
    if (isProcessing && step) {
      statusHtml = `<div class="material-progress">
        <div class="progress-text">${step}</div>
        ${pct ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ""}
      </div>`;
    } else {
      statusHtml = `<span class="status status-${mainStatus}">${mainStatus}</span>`;
    }

    return `<div class="material-item">
      <span class="material-name">${m.lecture_number ? `L${m.lecture_number}: ` : ""}${m.lecture_title || m.filename}</span>
      <div class="material-actions">
        ${statusHtml}
        <button class="btn-delete-material" onclick="deleteMaterial('${m.id}')" title="Delete material">&times;</button>
      </div>
    </div>`;
  }).join("");
}

async function onUploadMaterial(e) {
  e.preventDefault();
  if (!state.currentCourseId) { alert("Please select a course first."); return; }
  const fileInput = document.getElementById("file-input");
  if (!fileInput.files.length) { alert("Please select a file."); return; }

  const form = new FormData();
  form.append("file", fileInput.files[0]);
  const num = document.getElementById("upload-lecture-num").value;
  const title = document.getElementById("upload-lecture-title").value;
  if (num) form.append("lecture_number", num);
  if (title) form.append("lecture_title", title);

  const btn = document.getElementById("btn-upload-submit");
  btn.textContent = "Uploading...";
  btn.disabled = true;

  try {
    await api("POST", `/courses/${state.currentCourseId}/materials/`, form);
    closeModal("upload-modal");
    fileInput.value = "";
    document.getElementById("file-name").textContent = "";
    document.getElementById("upload-lecture-num").value = "";
    document.getElementById("upload-lecture-title").value = "";
    await loadMaterials();
    pollMaterials();
  } catch (err) {
    alert("Upload failed: " + err.message);
  } finally {
    btn.textContent = "Upload & Ingest";
    btn.disabled = false;
  }
}

function pollMaterials() {
  const interval = setInterval(async () => {
    await loadMaterials();
    await loadStats();
    const hasActive = state.materials.some(m => {
      const s = (m.status || "").split("|")[0];
      return s === "processing" || s === "pending";
    });
    if (!hasActive) clearInterval(interval);
  }, 10000);
}

async function deleteMaterial(materialId) {
  if (!confirm("Delete this material and all its chunks?")) return;
  try {
    await api("DELETE", `/courses/${state.currentCourseId}/materials/${materialId}`);
    await loadMaterials();
    await loadStats();
  } catch (err) {
    alert("Failed to delete: " + err.message);
  }
}

function showFileName() {
  const f = document.getElementById("file-input").files[0];
  document.getElementById("file-name").textContent = f ? f.name : "";
}

/* ===== Stats ===== */
async function loadStats() {
  if (!state.currentCourseId) { $courseStats.innerHTML = ""; return; }
  try {
    const s = await api("GET", `/courses/${state.currentCourseId}/stats`);
    $courseStats.innerHTML =
      `${s.materials} lectures &middot; ${s.total_pages} pages &middot; ${s.chunks} chunks`;
  } catch { $courseStats.innerHTML = ""; }
}

/* ===== Mode ===== */
function setMode(mode) {
  state.mode = mode;
  $modeButtons.forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  if (state.currentSessionId) {
    api("PATCH", `/chat/sessions/${state.currentSessionId}`, { mode }).catch(() => {});
  }
}

/* ===== Chat History ===== */
async function loadChatHistory() {
  const url = state.currentCourseId
    ? `/chat/sessions?course_id=${state.currentCourseId}`
    : "/chat/sessions";
  state.sessions = await api("GET", url);
  renderChatHistory();
}

function renderChatHistory() {
  if (!state.sessions.length) {
    $chatHistory.innerHTML = `<p style="font-size:12px;color:var(--text-muted);padding:4px;">No chats yet.</p>`;
    return;
  }
  $chatHistory.innerHTML = state.sessions.map(s => `
    <div class="chat-history-item ${s.id === state.currentSessionId ? 'active' : ''}"
         data-id="${s.id}" onclick="loadSession('${s.id}')">
      ${escapeHtml(s.title)}
    </div>
  `).join("");
}

async function loadSession(sessionId) {
  state.currentSessionId = sessionId;
  const session = await api("GET", `/chat/sessions/${sessionId}`);
  if (session.course_id && session.course_id !== state.currentCourseId) {
    state.currentCourseId = session.course_id;
    $courseSelect.value = session.course_id;
    await loadMaterials();
    await loadStats();
  }
  setMode(session.mode || "rag");

  const messages = await api("GET", `/chat/sessions/${sessionId}/messages`);
  renderMessages(messages);
  renderChatHistory();
}

/* ===== Chat ===== */
async function onNewChat() {
  state.currentSessionId = null;
  clearChatDisplay();
  $chatInput.focus();
}

function clearChatDisplay() {
  $chatMessages.innerHTML = "";
  $chatMessages.appendChild($welcomeScreen.cloneNode(true) || createWelcome());
  // re-show welcome
  const ws = $chatMessages.querySelector(".welcome-screen");
  if (ws) ws.classList.remove("hidden");
  renderChatHistory();
}

async function onSendMessage(e) {
  e.preventDefault();
  const text = $chatInput.value.trim();
  if (!text || state.sending) return;

  // Hide welcome
  const ws = $chatMessages.querySelector(".welcome-screen");
  if (ws) ws.remove();

  // Create session if needed
  if (!state.currentSessionId) {
    const session = await api("POST", "/chat/sessions", {
      course_id: state.currentCourseId,
      mode: state.mode,
      title: "New Chat",
    });
    state.currentSessionId = session.id;
    state.sessions.unshift(session);
    renderChatHistory();
  }

  // Show user message
  appendMessage("user", text);
  $chatInput.value = "";
  $chatInput.style.height = "auto";
  $btnSend.disabled = true;
  state.sending = true;
  $typingIndicator.classList.remove("hidden");
  scrollToBottom();

  try {
    const res = await api("POST", `/chat/sessions/${state.currentSessionId}/messages`, { content: text });
    $typingIndicator.classList.add("hidden");
    appendMessage("assistant", res.content, res.sources);
    await loadChatHistory();
  } catch (err) {
    $typingIndicator.classList.add("hidden");
    appendMessage("error", err.message);
  } finally {
    state.sending = false;
    scrollToBottom();
  }
}

function renderMessages(messages) {
  $chatMessages.innerHTML = "";
  if (!messages.length) {
    clearChatDisplay();
    return;
  }
  const ws = $chatMessages.querySelector(".welcome-screen");
  if (ws) ws.remove();

  messages.forEach(m => appendMessage(m.role, m.content, m.sources));
  scrollToBottom();
}

function appendMessage(role, content, sources = []) {
  const div = document.createElement("div");

  if (role === "user") {
    div.className = "message message-user";
    div.textContent = content;
  } else if (role === "error") {
    div.className = "message message-error";
    div.textContent = content;
  } else {
    div.className = "message message-assistant";
    div.innerHTML = renderMarkdown(content);

    if (sources && sources.length) {
      const srcDiv = document.createElement("div");
      srcDiv.className = "message-sources";
      srcDiv.innerHTML = "Sources: " + sources
        .filter(s => s.chunk_type === "slide")
        .map(s => `<span>L${s.lecture_number || "?"} Slide ${s.page_number || "?"}</span>`)
        .join("");
      div.appendChild(srcDiv);
    }
  }

  $chatMessages.appendChild(div);
  scrollToBottom();
}

/* ===== Input handling ===== */
function onInputChange() {
  $btnSend.disabled = !$chatInput.value.trim();
  // Auto-resize
  $chatInput.style.height = "auto";
  $chatInput.style.height = Math.min($chatInput.scrollHeight, 150) + "px";
}

function onInputKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $chatForm.dispatchEvent(new Event("submit"));
  }
}

/* Global helper used by welcome screen hints */
function setInput(text) {
  $chatInput.value = text;
  $chatInput.focus();
  onInputChange();
}

/* ===== Modals ===== */
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}
function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

/* ===== Utilities ===== */
function scrollToBottom() {
  requestAnimationFrame(() => {
    $chatMessages.scrollTop = $chatMessages.scrollHeight;
  });
}

function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

/* ===== Study Guide ===== */
async function onGenerateStudyGuide(e) {
  e.preventDefault();
  const topic = document.getElementById("study-topic").value.trim();
  if (!topic || !state.currentCourseId) return;

  const btn = document.getElementById("btn-study-submit");
  btn.textContent = "Generating...";
  btn.disabled = true;

  try {
    const res = await api("POST", `/chat/study-guide?course_id=${state.currentCourseId}`, { topic });
    closeModal("study-modal");
    document.getElementById("study-topic").value = "";

    // Show the study guide as a chat message in a new session
    await onNewChat();
    const ws = $chatMessages.querySelector(".welcome-screen");
    if (ws) ws.remove();

    appendMessage("user", `Generate a study guide on: ${topic}`);
    appendMessage("assistant", res.guide, res.sources);
  } catch (err) {
    alert("Study guide failed: " + err.message);
  } finally {
    btn.textContent = "Generate";
    btn.disabled = false;
  }
}

/* ===== Audio Overview ===== */
async function onGenerateAudioOverview(e) {
  e.preventDefault();
  const topic = document.getElementById("audio-topic").value.trim();
  if (!topic || !state.currentCourseId) return;

  const btn = document.getElementById("btn-audio-submit");
  btn.textContent = "Generating...";
  btn.disabled = true;

  try {
    const res = await api("POST", `/courses/${state.currentCourseId}/audio/overview`, { topic });
    closeModal("audio-modal");
    document.getElementById("audio-topic").value = "";

    // Show as a chat message in a new session-like flow (without persisting)
    await onNewChat();
    const ws = $chatMessages.querySelector(".welcome-screen");
    if (ws) ws.remove();

    appendMessage("user", `Generate an audio explanation on: ${topic}`);
    appendAudioAssistant(res.script || "(No script returned.)", res.sources || [], res.audio_url);
  } catch (err) {
    alert("Audio generation failed: " + err.message);
  } finally {
    btn.textContent = "Generate";
    btn.disabled = false;
  }
}

function appendAudioAssistant(script, sources = [], audioUrl = null) {
  const div = document.createElement("div");
  div.className = "message message-assistant";
  div.innerHTML = renderMarkdown(script);

  if (audioUrl) {
    const block = document.createElement("div");
    block.className = "audio-block";

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = audioUrl;

    const dl = document.createElement("a");
    dl.href = audioUrl;
    dl.download = "";
    dl.textContent = "Download audio";

    block.appendChild(audio);
    block.appendChild(dl);
    div.appendChild(block);
  }

  if (sources && sources.length) {
    const srcDiv = document.createElement("div");
    srcDiv.className = "message-sources";
    srcDiv.innerHTML = "Sources: " + sources
      .filter(s => s.chunk_type === "slide")
      .map(s => `<span>L${s.lecture_number || "?"} Slide ${s.page_number || "?"}</span>`)
      .join("");
    div.appendChild(srcDiv);
  }

  $chatMessages.appendChild(div);
  scrollToBottom();
}

function renderMarkdown(text) {
  // Protect LaTeX blocks from escaping: extract them first, replace after
  const latexBlocks = [];
  let processed = text;

  // Block LaTeX: $$...$$ or \[...\]
  processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    latexBlocks.push({ tex: tex.trim(), display: true });
    return `%%LATEX_${latexBlocks.length - 1}%%`;
  });
  processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) => {
    latexBlocks.push({ tex: tex.trim(), display: true });
    return `%%LATEX_${latexBlocks.length - 1}%%`;
  });

  // Inline LaTeX: $...$ or \(...\)
  processed = processed.replace(/\$([^\$\n]+?)\$/g, (_, tex) => {
    latexBlocks.push({ tex: tex.trim(), display: false });
    return `%%LATEX_${latexBlocks.length - 1}%%`;
  });
  processed = processed.replace(/\\\((.*?)\\\)/g, (_, tex) => {
    latexBlocks.push({ tex: tex.trim(), display: false });
    return `%%LATEX_${latexBlocks.length - 1}%%`;
  });

  let html = escapeHtml(processed);

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );
  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Headers
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Bullet lists
  html = html.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, m => `<ul>${m}</ul>`);
  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  // Paragraphs
  html = html.split(/\n{2,}/).map(p => {
    p = p.trim();
    if (!p) return "";
    if (/^<(pre|ul|ol|li|h[2-4])/.test(p)) return p;
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  }).join("");

  // Re-inject LaTeX — render with KaTeX if available
  html = html.replace(/%%LATEX_(\d+)%%/g, (_, idx) => {
    const block = latexBlocks[parseInt(idx)];
    if (!block) return "";
    try {
      if (typeof katex !== "undefined") {
        return katex.renderToString(block.tex, { displayMode: block.display, throwOnError: false });
      }
    } catch (e) { /* fall through */ }
    // Fallback: show raw LaTeX in a styled span
    return block.display
      ? `<div class="math-block">${escapeHtml(block.tex)}</div>`
      : `<span class="math-inline">${escapeHtml(block.tex)}</span>`;
  });

  return html;
}
