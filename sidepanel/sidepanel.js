const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let activeFilter = 'all';
let autoScroll = true; // auto-scroll feed to bottom
let cachedScreenshots = []; // shared screenshot cache for feed thumbnails
let currentSessionId = null;   // the session being viewed (from history or active)
let activeSessionId = null;    // the currently recording session (set by service worker)
let viewingHistorical = false; // true when viewing a past session from history
let knownEventCount = 0;
let rangeStartTs = null;  // event timestamp (ms) — start of selected range, null = unset
let rangeEndTs = null;    // event timestamp (ms) — end of selected range, null = unset
let rangeSessionStart = null; // session startTime (for display formatting)
let currentSessionEndTime = null; // session endTime (for live recording = now)

async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

// Tab switching
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    $('#filters').classList.toggle('hidden', tab.dataset.tab !== 'feed');
    if (tab.dataset.tab !== 'feed') {
      $('#note-bar').classList.add('hidden');
    } else if (activeSessionId) {
      $('#note-bar').classList.remove('hidden');
    }
    if (tab.dataset.tab === 'history') loadHistory();
    if (tab.dataset.tab === 'export') updateRangeExportBanner();
  });
});

// Filters
$$('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    applyFilter();
  });
});

// Auto-scroll pause toggle
$('#btn-autoscroll').addEventListener('click', () => {
  autoScroll = !autoScroll;
  const btn = $('#btn-autoscroll');
  btn.textContent = autoScroll ? 'Auto ↓' : 'Paused';
  btn.classList.toggle('paused', !autoScroll);
  if (autoScroll) {
    const feed = $('#feed');
    feed.scrollTop = feed.scrollHeight;
  }
});

function applyFilter() {
  $$('.event-item').forEach(el => {
    if (activeFilter === 'all') { el.classList.remove('hidden'); return; }
    if (activeFilter === 'media') {
      // Media filter: show screenshots and video notes
      el.classList.toggle('hidden', el.dataset.type !== 'event:screenshot' && el.dataset.type !== 'event:video');
    } else if (activeFilter === 'in-range') {
      // Show only events within the active range (or all if no range)
      const hasRange = rangeStartTs != null || rangeEndTs != null;
      el.classList.toggle('hidden', hasRange && !el.classList.contains('in-range'));
    } else {
      el.classList.toggle('hidden', el.dataset.type !== activeFilter);
    }
  });
}

function badgeClass(type) {
  if (type === 'event:dom') return 'badge-dom';
  if (type === 'event:console') return 'badge-warn';
  if (type.includes('network')) return 'badge-network';
  if (type === 'event:note') return 'badge-note';
  if (type === 'event:screenshot') return 'badge-info';
  if (type === 'event:video') return 'badge-info';
  return 'badge-info';
}

function eventLabel(ev) {
  if (ev.type === 'event:dom') {
    const ctx = ev.context || {};
    let label = `<strong>${ev.eventType}</strong>`;
    if (ctx.text) label += ` "${escHtml(ctx.text).slice(0, 60)}"`;
    if (ctx.tag) label += ` <code>${escHtml(ctx.tag)}</code>`;
    label += ` on <code>${escHtml(ev.selector)}</code>`;
    if (ev.value) label += ' = ' + escHtml(ev.value);
    return label;
  }
  if (ev.type === 'event:console') return `<span class="badge ${ev.level === 'error' ? 'badge-error' : 'badge-warn'}">${ev.level}</span> ${escHtml(ev.message).slice(0, 200)}`;
  if (ev.type.includes('network')) return `<strong>${ev.method}</strong> ${escHtml(ev.url).slice(0, 100)} → <span class="${ev.status >= 400 ? 'badge-error' : ''}">${ev.status}</span> (${ev.duration}ms)`;
  if (ev.type === 'event:note') return `<strong>📝</strong> ${escHtml(ev.content)}`;
  if (ev.type === 'event:screenshot') return `<strong>📸</strong> Screenshot captured`;
  if (ev.type === 'event:video') return `<strong>🎥</strong> ${escHtml(ev.content)}`;
  return JSON.stringify(ev).slice(0, 200);
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// Render a body block with pretty/copy buttons for JSON content
function renderBodyBlock(label, body) {
  if (!body) {
    const empty = document.createElement('div');
    empty.innerHTML = `<b>${label}:</b> <i>none</i>`;
    return empty;
  }

  // Try to detect and pretty-print JSON
  let prettyBody = null;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { prettyBody = JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
  }

  const container = document.createElement('div');
  container.innerHTML = `<b>${label}:</b>`;

  const actions = document.createElement('div');
  actions.className = 'body-actions';

  const pre = document.createElement('pre');
  pre.textContent = (prettyBody || body).slice(0, 3000);

  if (prettyBody) {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn-body-toggle';
    toggleBtn.textContent = 'Raw';
    toggleBtn._raw = body.slice(0, 3000);
    toggleBtn._pretty = prettyBody.slice(0, 3000);
    toggleBtn._pre = pre;
    actions.appendChild(toggleBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-body-copy';
  copyBtn.textContent = 'Copy';
  copyBtn._pre = pre;
  actions.appendChild(copyBtn);

  container.appendChild(actions);
  container.appendChild(pre);
  return container;
}

// Build expanded detail DOM element for an event
function buildEventDetails(ev) {
  const container = document.createElement('div');

  function addRow(html) {
    const row = document.createElement('div');
    row.innerHTML = html;
    container.appendChild(row);
  }

  if (ev.type === 'event:dom') {
    const ctx = ev.context || {};
    addRow(`<b>Event:</b> ${escHtml(ev.eventType)}`);
    addRow(`<b>Selector:</b> <code>${escHtml(ev.selector)}</code>`);
    if (ctx.tag) addRow(`<b>Tag:</b> ${escHtml(ctx.tag)}`);
    if (ctx.text) addRow(`<b>Text:</b> ${escHtml(ctx.text)}`);
    if (ev.value) addRow(`<b>Value:</b> ${escHtml(ev.value)}`);
    if (ctx.id) addRow(`<b>ID:</b> ${escHtml(ctx.id)}`);
    if (ctx.className) addRow(`<b>Class:</b> ${escHtml(ctx.className)}`);
  } else if (ev.type === 'event:console') {
    addRow(`<b>Level:</b> ${escHtml(ev.level)}`);
    addRow(`<b>Message:</b> ${escHtml(ev.message)}`);
    if (ev.stack) addRow(`<b>Stack:</b><pre>${escHtml(ev.stack)}</pre>`);
  } else if (ev.type.includes('network')) {
    addRow(`<b>Method:</b> ${escHtml(ev.method)}`);
    addRow(`<b>URL:</b> ${escHtml(ev.url)}`);
    addRow(`<b>Status:</b> ${ev.status} · <b>Duration:</b> ${ev.duration}ms`);
    container.appendChild(renderBodyBlock('Request Body', ev.requestBody));
    container.appendChild(renderBodyBlock('Response Body', ev.responseBody));
  } else if (ev.type === 'event:note') {
    addRow(`<b>Note:</b> ${escHtml(ev.content)}`);
  } else if (ev.type === 'event:video') {
    addRow(`<b>Video:</b> ${escHtml(ev.content)}`);
  }
  addRow(`<b>Time:</b> ${new Date(ev.timestamp).toLocaleString()}`);

  return container;
}

function isInRange(ev) {
  if (rangeStartTs == null && rangeEndTs == null) return false;
  if (rangeStartTs != null && ev.timestamp < rangeStartTs) return false;
  if (rangeEndTs != null && ev.timestamp > rangeEndTs) return false;
  return true;
}

function formatRangeOffset(ts) {
  if (ts == null) return '?';
  const start = rangeSessionStart || 0;
  const sec = (ts - start) / 1000;
  if (sec < 0) sec = 0;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateRangeBar() {
  const bar = $('#range-bar');
  const info = $('#range-info');
  const rangeFilterBtn = $('#filter-btn-in-range');
  if (rangeStartTs == null && rangeEndTs == null) {
    bar.classList.add('hidden');
    if (rangeFilterBtn) rangeFilterBtn.classList.add('hidden');
    return;
  }
  if (rangeFilterBtn) rangeFilterBtn.classList.remove('hidden');
  const start = formatRangeOffset(rangeStartTs);
  const end = formatRangeOffset(rangeEndTs);
  // Count events in range
  const inRangeEvents = Array.from($$('#feed .event-item')).filter(el => {
    const ts = parseInt(el.dataset.timestamp, 10);
    if (rangeStartTs != null && ts < rangeStartTs) return false;
    if (rangeEndTs != null && ts > rangeEndTs) return false;
    return true;
  }).length;
  info.textContent = `Range: ${start} → ${end} (${inRangeEvents} events)`;
  bar.classList.remove('hidden');
}

function refreshRangeHighlight() {
  $$('#feed .event-item').forEach(el => {
    const ts = parseInt(el.dataset.timestamp, 10);
    const inRange = (rangeStartTs == null && rangeEndTs == null)
      ? true
      : ((rangeStartTs == null || ts >= rangeStartTs) &&
         (rangeEndTs == null || ts <= rangeEndTs));
    el.classList.toggle('in-range', inRange);
  });
  refreshRangeEndpointClass();
  refreshRangeButtonText();
}

// Mark the start/end events so their range-action bar stays visible
function refreshRangeEndpointClass() {
  $$('#feed .event-item').forEach(el => {
    const ts = parseInt(el.dataset.timestamp, 10);
    el.classList.toggle('range-endpoint', ts === rangeStartTs || ts === rangeEndTs);
    el.classList.toggle('range-start', ts === rangeStartTs);
    el.classList.toggle('range-end', ts === rangeEndTs);
    // Insert a small marker into the event if it's an endpoint
    let marker = el.querySelector('.range-marker');
    if (ts === rangeStartTs || ts === rangeEndTs) {
      if (!marker) {
        marker = document.createElement('span');
        marker.className = 'range-marker';
        el.insertBefore(marker, el.firstChild);
      }
      marker.textContent = ts === rangeStartTs ? '▶ Start' : '◀ End';
      marker.className = `range-marker ${ts === rangeStartTs ? 'range-marker-start' : 'range-marker-end'}`;
    } else if (marker) {
      marker.remove();
    }
  });
}

// Update button text to show ✓ when this event is a range endpoint
function refreshRangeButtonText() {
  $$('#feed .event-item .event-range-actions').forEach(bar => {
    const el = bar.closest('.event-item');
    const ts = parseInt(el.dataset.timestamp, 10);
    const btns = bar.querySelectorAll('button');
    if (btns[0]) btns[0].textContent = rangeStartTs === ts ? '✓ Start' : 'Set as start';
    if (btns[1]) btns[1].textContent = rangeEndTs === ts ? '✓ End' : 'Set as end';
  });
}

// ========== Range Timeline (visual range selector) ==========

// Render the timeline with event ticks. Called when feed loads or session changes.
function renderRangeTimeline(events) {
  const tl = $('#range-timeline');
  const ticksEl = $('#timeline-ticks');
  const labelStart = $('#timeline-label-start');
  const labelEnd = $('#timeline-label-end');
  if (!tl || !ticksEl) return;

  if (!rangeSessionStart || !events || events.length === 0) {
    tl.classList.add('hidden');
    return;
  }
  tl.classList.remove('hidden');

  // Compute session duration (live recording has no endTime → use now)
  const sessionEnd = (activeSessionId && currentSessionId === activeSessionId)
    ? Date.now()
    : (currentSessionEndTime || Date.now());
  const durationMs = Math.max(sessionEnd - rangeSessionStart, 1000);

  // Update labels
  labelStart.textContent = '0:00';
  labelEnd.textContent = formatDuration(durationMs);

  // Place event ticks
  ticksEl.innerHTML = '';
  // Thin out ticks if too many (avoid DOM bloat for long sessions)
  const maxTicks = 200;
  const step = Math.max(1, Math.floor(events.length / maxTicks));
  for (let i = 0; i < events.length; i += step) {
    const ev = events[i];
    const offset = ((ev.timestamp - rangeSessionStart) / durationMs) * 100;
    const tick = document.createElement('div');
    tick.className = `timeline-tick event-${ev.type.split(':').pop()}`;
    tick.style.left = `${offset}%`;
    tick.title = `${new Date(ev.timestamp).toLocaleTimeString()} · ${ev.type}`;
    ticksEl.appendChild(tick);
  }

  refreshTimelineRange();
}

// Re-render the timeline by reading timestamps from the existing feed DOM.
// Used for live updates (cheaper than re-querying storage).
function renderRangeTimelineFromFeed() {
  if (!rangeSessionStart) return;
  const items = Array.from($$('#feed .event-item'));
  if (items.length === 0) return;
  // Reconstruct minimal event array from DOM
  const events = items.map(el => ({
    type: el.dataset.type,
    timestamp: parseInt(el.dataset.timestamp, 10),
  }));
  renderRangeTimeline(events);
}

// Position the range highlight + handles based on rangeStartTs/rangeEndTs
function refreshTimelineRange() {
  const rangeEl = $('#timeline-range');
  const handleStart = $('#timeline-handle-start');
  const handleEnd = $('#timeline-handle-end');
  if (!rangeEl || !handleStart || !handleEnd) return;

  // For active recording, endTime is null → use now() for live duration
  const sessionEnd = (activeSessionId && currentSessionId === activeSessionId)
    ? Date.now()
    : (currentSessionEndTime || Date.now());
  const durationMs = Math.max(sessionEnd - rangeSessionStart, 1);

  // No range → show full session, no filter
  if (rangeStartTs == null && rangeEndTs == null) {
    rangeEl.classList.add('full');
    rangeEl.style.left = '0%';
    rangeEl.style.width = '100%';
    handleStart.style.left = '0%';
    handleEnd.style.left = '100%';
    return;
  }
  rangeEl.classList.remove('full');

  const startOffset = rangeStartTs != null
    ? Math.max(0, Math.min(100, ((rangeStartTs - rangeSessionStart) / durationMs) * 100))
    : 0;
  const endOffset = rangeEndTs != null
    ? Math.max(0, Math.min(100, ((rangeEndTs - rangeSessionStart) / durationMs) * 100))
    : 100;

  rangeEl.style.left = `${startOffset}%`;
  rangeEl.style.width = `${endOffset - startOffset}%`;
  handleStart.style.left = `${startOffset}%`;
  handleEnd.style.left = `${endOffset}%`;
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Wire up drag on the two handles
function initRangeTimelineDrag() {
  const track = $('#timeline-track');
  if (!track) return;
  let activeHandle = null; // 'start' | 'end'
  let trackRect = null;

  const onMouseDown = (e) => {
    const handle = e.target.closest('.timeline-handle');
    if (handle) {
      activeHandle = handle.dataset.handle;
      e.preventDefault();
    } else {
      // Click on track → set range to a small window around click point
      trackRect = track.getBoundingClientRect();
      const pct = (e.clientX - trackRect.left) / trackRect.width;
      const sessionEnd = (activeSessionId && currentSessionId === activeSessionId)
        ? Date.now()
        : (currentSessionEndTime || Date.now());
      const durationMs = sessionEnd - rangeSessionStart;
      const clickTs = rangeSessionStart + pct * durationMs;
      const windowMs = Math.min(5000, durationMs * 0.05);
      rangeStartTs = Math.round(clickTs - windowMs / 2);
      rangeEndTs = Math.round(clickTs + windowMs / 2);
      activeHandle = null;
      onRangeChanged();
    }
    trackRect = track.getBoundingClientRect();
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const onMouseMove = (e) => {
    if (!trackRect) return;
    const pct = Math.max(0, Math.min(1, (e.clientX - trackRect.left) / trackRect.width));
    const sessionEnd = (activeSessionId && currentSessionId === activeSessionId)
      ? Date.now()
      : (currentSessionEndTime || Date.now());
    const durationMs = sessionEnd - rangeSessionStart;
    const ts = rangeSessionStart + pct * durationMs;

    if (activeHandle === 'start') {
      rangeStartTs = Math.round(ts);
      if (rangeEndTs != null && rangeStartTs > rangeEndTs) rangeStartTs = rangeEndTs;
    } else if (activeHandle === 'end') {
      rangeEndTs = Math.round(ts);
      if (rangeStartTs != null && rangeEndTs < rangeStartTs) rangeEndTs = rangeStartTs;
    }
    onRangeChanged();
  };

  const onMouseUp = () => {
    activeHandle = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  track.addEventListener('mousedown', onMouseDown);
}

// Single update path for all range changes (used by handles, buttons, click)
function onRangeChanged() {
  updateRangeBar();
  refreshRangeHighlight();
  refreshTimelineRange();
}

// Replace the older setRangeStart/setRangeEnd/clearRange to use the unified path
function setRangeStart(ts) {
  if (rangeEndTs != null && ts > rangeEndTs) {
    rangeStartTs = rangeEndTs;
    rangeEndTs = ts;
  } else {
    rangeStartTs = ts;
  }
  onRangeChanged();
}
function setRangeEnd(ts) {
  if (rangeStartTs != null && ts < rangeStartTs) {
    rangeEndTs = rangeStartTs;
    rangeStartTs = ts;
  } else {
    rangeEndTs = ts;
  }
  onRangeChanged();
}
function clearRange() {
  rangeStartTs = null;
  rangeEndTs = null;
  onRangeChanged();
}

function renderEvent(ev) {
  const div = document.createElement('div');
  div.className = 'event-item' + (ev.type === 'event:note' ? ' note-event' : '') + (ev.type === 'event:screenshot' ? ' screenshot-event' : '') + (ev.type === 'event:video' ? ' video-event' : '');
  div.dataset.type = ev.type;
  div.dataset.timestamp = ev.timestamp;
  if (isInRange(ev)) div.classList.add('in-range');
  // Mark network errors (4xx/5xx/0) so they can be styled distinctly
  if (ev.type.includes('network') && (ev.status >= 400 || ev.status === 0)) {
    div.classList.add('event-error-network');
  }
  const t = new Date(ev.timestamp);
  const time = t.toLocaleTimeString() + '.' + String(t.getMilliseconds()).padStart(3, '0');
  div.innerHTML = `<span class="time">${time}</span> <span class="badge ${badgeClass(ev.type)}">${ev.type.split(':').pop()}</span><div class="detail">${eventLabel(ev)}</div>`;

  // Expandable details on click (skip for screenshots/videos — thumbnail is already visible)
  if (ev.type !== 'event:screenshot' && ev.type !== 'event:video') {
    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'event-details hidden';
    detailsDiv.appendChild(buildEventDetails(ev));
    div.appendChild(detailsDiv);

    div.addEventListener('click', (e) => {
      // Handle body action buttons
      const toggleBtn = e.target.closest('.btn-body-toggle');
      if (toggleBtn) {
        e.stopPropagation();
        const isRaw = toggleBtn.textContent === 'Raw';
        toggleBtn._pre.textContent = isRaw ? toggleBtn._raw : toggleBtn._pretty;
        toggleBtn.textContent = isRaw ? 'Pretty' : 'Raw';
        return;
      }
      const copyBtn = e.target.closest('.btn-body-copy');
      if (copyBtn) {
        e.stopPropagation();
        navigator.clipboard.writeText(copyBtn._pre.textContent).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1000);
        });
        return;
      }
      // Toggle expand
      div.classList.toggle('expanded');
      detailsDiv.classList.toggle('hidden');
    });
  }

  // Show thumbnail for screenshot events using cached data
  if (ev.type === 'event:screenshot' && ev.screenshotId) {
    const s = cachedScreenshots.find(sc => sc.id === ev.screenshotId);
    if (s) {
      const thumb = document.createElement('img');
      thumb.className = 'feed-screenshot-thumb';
      thumb.dataset.screenshotId = ev.screenshotId;
      thumb.title = 'Click to open annotator';
      thumb.src = s.annotatedDataUrl || s.dataUrl;
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.windows.create({
          url: chrome.runtime.getURL(`annotator/annotator.html?id=${ev.screenshotId}`),
          type: 'popup', width: 900, height: 700
        });
      });
      div.appendChild(thumb);
    }
  }

  // Show video thumbnail for video events — click opens in popup viewer
  if (ev.type === 'event:video' && ev.videoId) {
    const v = cachedScreenshots.find(sc => sc.id === ev.videoId);
    if (v && v.videoBlob) {
      const video = document.createElement('video');
      video.className = 'feed-video-thumb';
      video.src = URL.createObjectURL(v.videoBlob);
      video.preload = 'metadata';
      video.title = 'Click to open video';
      video.addEventListener('click', (e) => {
        e.stopPropagation();
        const blobUrl = URL.createObjectURL(v.videoBlob);
        const w = window.open('', '_blank', 'width=900,height=700');
        w.document.title = 'Debug Helper - Video';
        w.document.body.style.cssText = 'margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh';
        const player = w.document.createElement('video');
        player.src = blobUrl;
        player.controls = true;
        player.autoplay = true;
        player.style.maxWidth = '100%';
        player.style.maxHeight = '100%';
        w.document.body.appendChild(player);
      });
      div.appendChild(video);
    }
  }

  // Range actions bar — ALWAYS visible on every event so the user can
  // mark a range without first expanding the event detail.
  div.appendChild(buildRangeActions(ev));

  return div;
}

// Small "Set as start/end" button bar — used inline below screenshot/video thumbnails
// since those event types don't have an expandable detail panel.
function buildRangeActions(ev) {
  const actions = document.createElement('div');
  actions.className = 'event-range-actions';
  // For video events, "Set as end" should use the END of the recording (start + duration)
  // so the entire video content is included in the range.
  const isVideo = ev.type === 'event:video';
  const endTs = isVideo && ev.videoDurationMs
    ? ev.timestamp + ev.videoDurationMs
    : ev.timestamp;
  const startBtn = document.createElement('button');
  startBtn.className = 'btn btn-sm';
  startBtn.textContent = rangeStartTs === ev.timestamp ? '✓ Start' : 'Set as start';
  startBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setRangeStart(ev.timestamp);
  });
  const endBtn = document.createElement('button');
  endBtn.className = 'btn btn-sm';
  endBtn.textContent = rangeEndTs === endTs ? '✓ End' : (isVideo ? 'Set as end (video end)' : 'Set as end');
  endBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setRangeEnd(endTs);
  });
  actions.appendChild(startBtn);
  actions.appendChild(endBtn);
  return actions;
}

async function loadFeed() {
  let state;
  try {
    state = await send({ type: 'session:get' });
  } catch { return; } // service worker unavailable
  const statusEl = $('#status');
  const noteBar = $('#note-bar');

  // Check which tab is active — only show note-bar on feed tab
  const onFeedTab = document.querySelector('.tab[data-tab="feed"]')?.classList.contains('active');

  if (state.recording) {
    statusEl.textContent = 'Recording';
    statusEl.className = 'status-badge recording';
    activeSessionId = state.session.id;
    currentSessionId = state.session.id;
    rangeSessionStart = state.session.startTime;
    currentSessionEndTime = state.session.endTime || Date.now();
    viewingHistorical = false;
    if (onFeedTab) noteBar.classList.remove('hidden');
  } else if (state.session) {
    noteBar.classList.add('hidden');
    // Session exists (either just stopped or from lastSessionId)
    if (activeSessionId && activeSessionId === state.session.id && state.session.endTime) {
      // Was recording, now stopped — auto-show this session
      statusEl.textContent = 'Session ended';
      statusEl.className = 'status-badge';
      currentSessionId = state.session.id;
      rangeSessionStart = state.session.startTime;
      currentSessionEndTime = state.session.endTime;
      activeSessionId = null;
      loadHistory(); // refresh history list
    } else if (!viewingHistorical) {
      // Show last session
      statusEl.textContent = state.session.endTime ? 'Last session' : 'Idle';
      statusEl.className = 'status-badge';
      currentSessionId = state.session.id;
      rangeSessionStart = state.session.startTime;
      currentSessionEndTime = state.session.endTime || Date.now();
    } else {
      statusEl.textContent = 'Viewing history';
      statusEl.className = 'status-badge';
    }
  } else {
    statusEl.textContent = viewingHistorical ? 'Viewing history' : 'Idle';
    statusEl.className = 'status-badge';
    activeSessionId = null;
    noteBar.classList.add('hidden');
  }

  updateRecordButton();

  if (!currentSessionId) return;

  const sid = currentSessionId;
  const all = await chrome.storage.local.get(null);
  let events = [];
  for (const k in all) {
    if (k.startsWith('events:' + sid + ':')) {
      events = events.concat(all[k]);
    }
  }

  // Always refresh screenshot cache to pick up annotation edits
  // Read directly from IndexedDB to preserve video blobs (can't survive message passing)
  try {
    cachedScreenshots = await getMediaFromDB(sid);
  } catch { cachedScreenshots = []; }

  if (events.length !== knownEventCount) {
    events.sort((a, b) => a.timestamp - b.timestamp);
    const feed = $('#feed');
    if (events.length > knownEventCount && knownEventCount > 0) {
      // Append only new events to preserve expanded state
      const newEvents = events.slice(knownEventCount);
      newEvents.forEach(ev => feed.appendChild(renderEvent(ev)));
    } else {
      // Full re-render (first load, session switch, or events decreased)
      feed.innerHTML = '';
      events.forEach(ev => feed.appendChild(renderEvent(ev)));
    }
    if (autoScroll) $('#tab-feed').scrollTop = $('#tab-feed').scrollHeight;
    knownEventCount = events.length;
    applyFilter();
    renderGallery(cachedScreenshots);
    renderRangeTimeline(events);
    if (rangeStartTs != null || rangeEndTs != null) updateRangeBar();
  } else {
    // Update existing feed thumbnails with latest screenshot data (e.g. after annotation)
    $$('.feed-screenshot-thumb').forEach(thumb => {
      const s = cachedScreenshots.find(sc => sc.id === thumb.dataset.screenshotId);
      if (s) {
        const newSrc = s.annotatedDataUrl || s.dataUrl;
        if (thumb.src !== newSrc) thumb.src = newSrc;
      }
    });
    renderGallery(cachedScreenshots);
  }
}

// Toggle recording
$('#btn-record').addEventListener('click', async () => {
  const btn = $('#btn-record');
  btn.disabled = true;
  try {
    if (activeSessionId) {
      // Stop video recording if active — wait for save to complete before ending session
      if (videoRecorder && videoRecorder.state === 'recording') await stopVideoRecording();
      await send({ type: 'session:stop' });
    } else {
      await send({ type: 'session:start' });
    }
    knownEventCount = -1;
    loadFeed();
  } catch (err) {
    console.error('[Debug Helper] Record toggle failed:', err);
  } finally {
    btn.disabled = false;
  }
});

function updateRecordButton() {
  const btn = $('#btn-record');
  if (activeSessionId) {
    btn.textContent = 'Stop';
    btn.title = 'Stop recording';
    btn.classList.add('recording');
  } else {
    btn.textContent = 'Record';
    btn.title = 'Start recording';
    btn.classList.remove('recording');
  }
}

// Add note
async function addNote() {
  const input = $('#note-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await send({ type: 'event:note', content: text, timestamp: Date.now() });
  // Flush buffer immediately so the note appears in storage right away
  await send({ type: 'session:flush' });
}

$('#btn-add-note').addEventListener('click', addNote);
$('#btn-add-note').disabled = true;
$('#note-input').addEventListener('input', () => {
  $('#btn-add-note').disabled = !$('#note-input').value.trim();
});

// Range banner controls
$('#btn-range-clear').addEventListener('click', clearRange);
$('#btn-range-export').addEventListener('click', () => {
  // Switch to Export tab — range is read by getExportFilters() on generate
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[data-tab="export"]').classList.add('active');
  $('#tab-export').classList.add('active');
  $('#filters').classList.add('hidden');
  updateRangeExportBanner();
});
$('#note-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addNote();
});

// Feed capture screenshot button
$('#btn-feed-capture').addEventListener('click', async () => {
  const btn = $('#btn-feed-capture');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await send({ type: 'screenshot:capture' });
    if (result?.error) {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Capture'; }, 1500);
      return;
    }
    knownEventCount = -1;
    loadFeed();
    btn.textContent = 'Capture';
  } catch {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Capture'; }, 1500);
  } finally {
    btn.disabled = false;
  }
});

// Video recording
let videoRecorder = null;
let videoChunks = [];
let videoStream = null;
let videoSessionId = null; // capture session ID at recording start
let videoSourceKind = null; // 'tab' or 'desktop' — tracks which button owns the active recording

// Acquire a MediaStream for the given source kind. Resolves with the stream.
async function acquireVideoStream(sourceKind) {
  if (sourceKind === 'tab') {
    const result = await send({ type: 'video:streamId' });
    if (result?.error) throw new Error(result.error);
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: result.streamId,
        }
      }
    });
  }
  // 'desktop' — show Chrome's native picker (screen / window / tab)
  const streamId = await new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(
      ['screen', 'window', 'tab'],
      null,
      (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!id) {
          reject(new Error('Picker cancelled'));
          return;
        }
        resolve(id);
      }
    );
  });
  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
      }
    }
  });
}

async function startVideoRecording(sourceKind = 'tab') {
  const btn = sourceKind === 'desktop' ? $('#btn-video-desktop') : $('#btn-video');
  if (!activeSessionId) {
    btn.textContent = 'Record first';
    setTimeout(() => { btn.textContent = sourceKind === 'desktop' ? '🖥️' : 'Video'; }, 1500);
    return;
  }
  // Prevent starting a second recording on top of one in progress
  if (videoRecorder && videoRecorder.state === 'recording') {
    return;
  }
  try {
    videoStream = await acquireVideoStream(sourceKind);
    videoSourceKind = sourceKind;
    videoChunks = [];
    videoSessionId = currentSessionId;
    // Capture start time so the video event marks the BEGINNING of the recording
    // (not the stop time, which would skip the video content when used as a range anchor)
    const videoStartTime = Date.now();
    videoRecorder = new MediaRecorder(videoStream, { mimeType: 'video/webm;codecs=vp9' });
    videoRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) videoChunks.push(e.data);
    };
    videoRecorder.onstop = async () => {
      const videoStopTime = Date.now();
      const videoDurationMs = videoStopTime - videoStartTime;
      const blob = new Blob(videoChunks, { type: 'video/webm' });
      videoChunks = [];
      const videoId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      // Save video blob directly to IndexedDB from sidepanel
      try {
        const db = await openMediaDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('screenshots', 'readwrite');
          tx.objectStore('screenshots').put({
            id: videoId,
            sessionId: videoSessionId,
            mediaType: 'video',
            videoBlob: blob,
            videoStartTime,
            videoDurationMs,
            timestamp: videoStartTime
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        console.error('[Debug Helper] Failed to save video:', err);
      }
      // Refresh cache BEFORE writing event so renderEvent can find the video blob
      const sid = videoSessionId;
      if (sid) {
        cachedScreenshots = await getMediaFromDB(sid);
        renderGallery(cachedScreenshots);

        const videoEvent = {
          type: 'event:video',
          content: `Video recorded (${(blob.size / 1024 / 1024).toFixed(1)} MB, ${(videoDurationMs / 1000).toFixed(1)}s)`,
          videoId,
          videoStartTime,
          videoDurationMs,
          timestamp: videoStartTime,  // mark START of recording, not stop
          _sessionId: sid
        };
        // Try sending through service worker buffer first (avoids race with flushBuffer)
        let buffered = false;
        try {
          const result = await send(videoEvent);
          buffered = result && result.buffered;
        } catch { /* service worker unavailable */ }
        // Fallback: write directly if buffer didn't accept (session already stopped)
        if (!buffered) {
          const allKeys = await chrome.storage.local.get(null);
          let lastChunk = 0;
          for (const k in allKeys) {
            if (k.startsWith('events:' + sid + ':')) {
              const idx = parseInt(k.split(':')[2], 10);
              if (idx > lastChunk) lastChunk = idx;
            }
          }
          const chunkKey = `events:${sid}:${lastChunk}`;
          // Fresh read of just this chunk to minimize race window
          const freshData = await chrome.storage.local.get(chunkKey);
          const existing = freshData[chunkKey] || [];
          existing.push(videoEvent);
          await chrome.storage.local.set({ [chunkKey]: existing });
        }
      }
    };
    videoRecorder.start(1000); // collect in 1s chunks
    btn.textContent = 'Stop';
    btn.classList.add('recording-video');
  } catch (err) {
    console.error('[Debug Helper] Video recording failed:', err);
    if (err.message === 'Picker cancelled') {
      // user dismissed the native picker — restore the button quietly
      btn.textContent = sourceKind === 'desktop' ? '🖥️' : 'Video';
    } else {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = sourceKind === 'desktop' ? '🖥️' : 'Video'; }, 1500);
    }
  }
}

// Returns a promise that resolves after onstop handler completes
function stopVideoRecording() {
  const tabBtn = $('#btn-video');
  const desktopBtn = $('#btn-video-desktop');
  const activeBtn = videoSourceKind === 'desktop' ? desktopBtn : tabBtn;
  activeBtn.textContent = 'Saving...';
  activeBtn.classList.remove('recording-video');
  const restoreBtn = () => {
    activeBtn.textContent = videoSourceKind === 'desktop' ? '🖥️' : 'Video';
    videoSourceKind = null;
  };
  return new Promise((resolve) => {
    if (videoRecorder && videoRecorder.state !== 'inactive') {
      const origOnStop = videoRecorder.onstop;
      videoRecorder.onstop = async (e) => {
        // Run original handler first (saves blob + event)
        if (origOnStop) await origOnStop(e);
        // Clean up stream and recorder AFTER save completes
        if (videoStream) {
          videoStream.getTracks().forEach(t => t.stop());
          videoStream = null;
        }
        videoRecorder = null;
        restoreBtn();
        resolve();
      };
      videoRecorder.stop();
    } else {
      if (videoStream) {
        videoStream.getTracks().forEach(t => t.stop());
        videoStream = null;
      }
      videoRecorder = null;
      restoreBtn();
      resolve();
    }
  });
}

$('#btn-video').addEventListener('click', () => {
  if (videoRecorder && videoRecorder.state === 'recording' && videoSourceKind === 'tab') {
    stopVideoRecording();
  } else {
    startVideoRecording('tab');
  }
});

$('#btn-video-desktop').addEventListener('click', () => {
  if (videoRecorder && videoRecorder.state === 'recording' && videoSourceKind === 'desktop') {
    stopVideoRecording();
  } else {
    startVideoRecording('desktop');
  }
});

// Render gallery from media array (screenshots + videos)
function renderGallery(mediaItems) {
  const gallery = $('#gallery');
  gallery.innerHTML = '';
  mediaItems.forEach(s => {
    if (s.mediaType === 'video' && s.videoBlob) {
      // Video item
      const wrapper = document.createElement('div');
      wrapper.className = 'gallery-video';
      const video = document.createElement('video');
      video.src = URL.createObjectURL(s.videoBlob);
      video.controls = true;
      video.preload = 'metadata';
      video.title = new Date(s.timestamp).toLocaleString();
      // Action buttons
      const actions = document.createElement('div');
      actions.className = 'gallery-video-actions';
      // Open in popup
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-sm btn-primary';
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => {
        const blobUrl = URL.createObjectURL(s.videoBlob);
        const w = window.open('', '_blank', 'width=900,height=700');
        w.document.title = 'Debug Helper - Video';
        w.document.body.style.cssText = 'margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh';
        const v = w.document.createElement('video');
        v.src = blobUrl;
        v.controls = true;
        v.autoplay = true;
        v.style.maxWidth = '100%';
        v.style.maxHeight = '100%';
        w.document.body.appendChild(v);
      });
      // Download
      const dlBtn = document.createElement('button');
      dlBtn.className = 'btn btn-sm';
      dlBtn.textContent = 'Download';
      dlBtn.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(s.videoBlob);
        const ts = new Date(s.timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `debug-video-${ts}.webm`;
        a.click();
      });
      actions.appendChild(openBtn);
      actions.appendChild(dlBtn);
      wrapper.appendChild(video);
      wrapper.appendChild(actions);
      gallery.appendChild(wrapper);
    } else {
      // Screenshot item
      const img = document.createElement('img');
      img.src = s.annotatedDataUrl || s.dataUrl;
      img.title = new Date(s.timestamp).toLocaleString();
      img.addEventListener('click', () => {
        chrome.windows.create({
          url: chrome.runtime.getURL(`annotator/annotator.html?id=${s.id}`),
          type: 'popup', width: 900, height: 700
        });
      });
      gallery.appendChild(img);
    }
  });
}

// Open IndexedDB with store creation to avoid missing-store errors
function openMediaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('debug-helper', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('screenshots')) {
        db.createObjectStore('screenshots', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Read media directly from IndexedDB (blobs can't survive chrome.runtime.sendMessage)
async function getMediaFromDB(sessionId) {
  const db = await openMediaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('screenshots', 'readonly');
    const req = tx.objectStore('screenshots').getAll();
    req.onsuccess = () => {
      resolve(req.result.filter(s => s.sessionId === sessionId).sort((a, b) => a.timestamp - b.timestamp));
    };
    req.onerror = () => reject(req.error);
  });
}

async function loadScreenshots() {
  if (!currentSessionId) return;
  cachedScreenshots = await getMediaFromDB(currentSessionId);
  renderGallery(cachedScreenshots);
}

// View a specific session (from history click)
function viewSession(sessionId) {
  currentSessionId = sessionId;
  viewingHistorical = sessionId !== activeSessionId;
  knownEventCount = -1; // force reload
  // Reset range — old timestamps wouldn't match new session's events
  clearRange();
  // Switch to feed tab
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[data-tab="feed"]').classList.add('active');
  $('#tab-feed').classList.add('active');
  $('#filters').classList.remove('hidden');
  loadFeedForSession(sessionId);
  loadScreenshotsForSession(sessionId);
}

async function loadFeedForSession(sessionId) {
  if (!sessionId) return;
  const sid = sessionId;
  // Read THIS session's metadata directly from storage (session:get would return
  // the current session, not the historical one we're viewing)
  const sessionData = await chrome.storage.local.get('session:' + sid);
  const sessionMeta = sessionData['session:' + sid];
  if (sessionMeta) {
    rangeSessionStart = sessionMeta.startTime;
    currentSessionEndTime = sessionMeta.endTime || Date.now();
  }

  const all = await chrome.storage.local.get(null);
  let events = [];
  for (const k in all) {
    if (k.startsWith('events:' + sid + ':')) {
      events = events.concat(all[k]);
    }
  }

  // Refresh media cache before rendering (read directly from IndexedDB to preserve blobs)
  cachedScreenshots = await getMediaFromDB(sid);
  events.sort((a, b) => a.timestamp - b.timestamp);
  const feed = $('#feed');
  feed.innerHTML = '';
  events.forEach(ev => feed.appendChild(renderEvent(ev)));
  if (autoScroll) $('#tab-feed').scrollTop = $('#tab-feed').scrollHeight;
  knownEventCount = events.length;
  applyFilter();
  renderGallery(cachedScreenshots);
  renderRangeTimeline(events);
}

async function loadScreenshotsForSession(sessionId) {
  if (!sessionId) return;
  cachedScreenshots = await getMediaFromDB(sessionId);
  renderGallery(cachedScreenshots);
}

// History
function updateDeleteSelectedBtn() {
  const checked = $$('.session-check:checked');
  $('#btn-delete-selected').disabled = checked.length === 0;
  $('#btn-delete-selected').textContent = checked.length ? `Delete (${checked.length})` : 'Delete Selected';
}

async function loadHistory() {
  const sessions = await send({ type: 'session:list' });
  const list = $('#history-list');
  list.innerHTML = '';
  sessions.forEach(s => {
    const div = document.createElement('div');
    div.className = 'session-item';
    const start = new Date(s.startTime).toLocaleString();
    const dur = s.endTime ? Math.round((s.endTime - s.startTime) / 1000) + 's' : 'ongoing';
    const isActive = s.id === currentSessionId;
    const title = s.title ? escHtml(s.title) : '';
    div.innerHTML = `
      <div class="session-row">
        <input type="checkbox" class="session-check" data-id="${s.id}">
        <div class="session-info">
          <div class="session-title ${title ? '' : 'untitled'}" data-id="${s.id}">${title || 'Untitled session'}</div>
          <div class="url">${escHtml(s.url)}</div>
          <div class="meta">${start} · ${dur} · ${s.eventCount} events${isActive ? ' · <strong>viewing</strong>' : ''}</div>
        </div>
      </div>
      <div class="session-actions">
        <button class="btn btn-sm session-view" data-id="${s.id}">View</button>
        <button class="btn btn-sm session-export" data-id="${s.id}">Export</button>
        <button class="btn btn-sm session-rename" data-id="${s.id}" data-title="${escHtml(s.title || '')}">Rename</button>
        <button class="btn btn-sm session-delete" data-id="${s.id}" style="color:var(--danger)">Delete</button>
      </div>
    `;
    list.appendChild(div);
  });

  // Checkbox change
  $$('.session-check').forEach(cb => cb.addEventListener('change', updateDeleteSelectedBtn));

  // Click on title to rename
  $$('.session-title').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      renameSession(el.dataset.id, el.textContent === 'Untitled session' ? '' : el.textContent);
    });
  });

  // Bind actions
  $$('.session-view').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); viewSession(btn.dataset.id); });
  });

  $$('.session-export').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.id;
      currentSessionId = sid;
      viewingHistorical = sid !== activeSessionId;
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab[data-tab="export"]').classList.add('active');
      $('#tab-export').classList.add('active');
      $('#filters').classList.add('hidden');
    });
  });

  $$('.session-rename').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      renameSession(btn.dataset.id, btn.dataset.title);
    });
  });

  $$('.session-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this session?')) return;
      await send({ type: 'session:clear', sessionId: btn.dataset.id });
      loadHistory();
    });
  });

  updateDeleteSelectedBtn();
}

async function renameSession(sessionId, currentTitle) {
  const title = prompt('Session title:', currentTitle || '');
  if (title === null) return;
  await send({ type: 'session:update', sessionId, updates: { title } });
  loadHistory();
}

// Delete selected sessions
$('#btn-delete-selected').addEventListener('click', async () => {
  const checked = [...$$('.session-check:checked')].map(cb => cb.dataset.id);
  if (!checked.length) return;
  if (!confirm(`Delete ${checked.length} session(s)?`)) return;
  for (const id of checked) await send({ type: 'session:clear', sessionId: id });
  if (checked.includes(currentSessionId)) { currentSessionId = null; viewingHistorical = false; }
  loadHistory();
});

$('#btn-select-all').addEventListener('click', () => {
  const checks = $$('.session-check');
  const allChecked = [...checks].every(cb => cb.checked);
  checks.forEach(cb => cb.checked = !allChecked);
  updateDeleteSelectedBtn();
});

// Export
let lastExportText = '';
let lastExportFormat = 'md';

function getExportFilters() {
  const filters = {};
  $$('#tab-export .filter-section input[data-filter]').forEach(cb => {
    filters[cb.dataset.filter] = cb.checked;
  });
  // Map 2 checkboxes (errorsOnly, allRequests) onto legacy booleans for export.js.
  // "All" wins if both are checked (it's a superset). Both unchecked = no network.
  const all = !!filters.allRequests;
  const errors = !!filters.errorsOnly;
  delete filters.allRequests;
  delete filters.errorsOnly;
  filters.network = all || errors;
  filters.networkErrorsOnly = errors && !all;
  // Pass range if active (lib/export.js uses these to filter events + screenshots)
  if (rangeStartTs != null) filters.rangeStartTs = rangeStartTs;
  if (rangeEndTs != null) filters.rangeEndTs = rangeEndTs;
  return filters;
}

// Show a banner in the Export tab if a range is active
function updateRangeExportBanner() {
  const banner = $('#export-range-banner');
  if (!banner) return;
  if (rangeStartTs == null && rangeEndTs == null) {
    banner.classList.add('hidden');
    return;
  }
  const start = formatRangeOffset(rangeStartTs);
  const end = formatRangeOffset(rangeEndTs);
  banner.textContent = `Filtering to range: ${start} → ${end}`;
  banner.classList.remove('hidden');
}

async function generatePreview(format) {
  if (!currentSessionId) return;
  const btnMap = { markdown: $('#btn-preview-md'), json: $('#btn-preview-json'), toon: $('#btn-preview-toon') };
  const btn = btnMap[format];
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const result = await send({ type: 'export:generate', sessionId: currentSessionId, format, filters: getExportFilters() });
    if (!result || result.error) {
      $('#export-preview').textContent = result?.error || 'No data — is a session selected?';
      $('#preview-info').textContent = 'Error';
      $('#export-preview-wrap').classList.remove('hidden');
      return;
    }

    if (format === 'markdown') {
      lastExportText = result.markdown;
      lastExportFormat = 'md';
    } else if (format === 'toon') {
      lastExportText = result.toon;
      lastExportFormat = 'toon';
    } else {
      // Strip internal fields from preview/copy
      const clean = JSON.parse(JSON.stringify(result));
      if (clean.debugReport) {
        delete clean.debugReport._screenshotFiles;
        delete clean.debugReport._videoFiles;
      }
      lastExportText = JSON.stringify(clean, null, 2);
      lastExportFormat = 'json';
    }

    $('#export-preview').textContent = lastExportText;
    const sizeKB = (new Blob([lastExportText]).size / 1024).toFixed(1);
    $('#preview-info').textContent = `${format.toUpperCase()} · ${sizeKB} KB`;
    $('#export-preview-wrap').classList.remove('hidden');
    // Show "Play videos" button if the current session has any videos
    updatePlayVideosButton();
  } finally {
    const labels = { markdown: 'Preview Markdown', json: 'Preview JSON', toon: 'Preview TOON' };
    btn.textContent = labels[format];
    btn.disabled = false;
  }
}

// Quick export — one-click copy markdown with default filters
$('#btn-quick-export').addEventListener('click', async () => {
  const btn = $('#btn-quick-export');
  const sid = currentSessionId;
  if (!sid) { btn.textContent = 'No session'; setTimeout(() => btn.textContent = 'Quick Copy', 1500); return; }
  btn.textContent = 'Exporting...';
  btn.disabled = true;
  try {
    const result = await send({ type: 'export:generate', sessionId: sid, format: 'markdown', filters: getExportFilters() });
    if (result?.markdown) {
      try { await navigator.clipboard.writeText(result.markdown); }
      catch { /* fallback */ const ta = document.createElement('textarea'); ta.value = result.markdown; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      btn.textContent = 'Copied!';
    }
  } finally {
    btn.disabled = false;
    setTimeout(() => btn.textContent = 'Quick Copy', 1500);
  }
});

$('#btn-delete-all').addEventListener('click', async () => {
  const sessions = await send({ type: 'session:list' });
  if (!sessions.length) return;
  if (!confirm(`Delete all ${sessions.length} sessions?`)) return;
  for (const s of sessions) await send({ type: 'session:clear', sessionId: s.id });
  currentSessionId = null;
  viewingHistorical = false;
  knownEventCount = 0;
  $('#feed').innerHTML = '';
  $('#gallery').innerHTML = '';
  loadHistory();
});

$('#btn-preview-md').addEventListener('click', () => generatePreview('markdown'));
$('#btn-preview-json').addEventListener('click', () => generatePreview('json'));
$('#btn-preview-toon').addEventListener('click', () => generatePreview('toon'));

$('#btn-debug-events').addEventListener('click', async () => {
  if (!currentSessionId) { alert('No session selected'); return; }
  const result = await send({ type: 'debug:events', sessionId: currentSessionId });
  $('#export-preview').textContent = JSON.stringify(result, null, 2);
  $('#export-preview-wrap').classList.remove('hidden');
  $('#preview-info').textContent = 'DEBUG';
});

function updatePlayVideosButton() {
  const btn = $('#btn-play-videos');
  if (!btn) return;
  const hasVideos = cachedScreenshots.some(s => s.mediaType === 'video' && s.videoBlob);
  btn.style.display = hasVideos ? '' : 'none';
}

$('#btn-play-videos').addEventListener('click', () => {
  const videos = cachedScreenshots
    .filter(s => s.mediaType === 'video' && s.videoBlob)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (videos.length === 0) return;
  if (videos.length === 1) {
    openVideoPopup(videos[0]);
  } else {
    // Open a picker window for multiple videos
    openVideoPicker(videos);
  }
});

function openVideoPopup(video) {
  const blobUrl = URL.createObjectURL(video.videoBlob);
  const w = window.open('', '_blank', 'width=900,height=700');
  w.document.title = 'Debug Helper - Video';
  w.document.body.style.cssText = 'margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh';
  const player = w.document.createElement('video');
  player.src = blobUrl;
  player.controls = true;
  player.autoplay = true;
  player.style.maxWidth = '100%';
  player.style.maxHeight = '100%';
  w.document.body.appendChild(player);
}

function openVideoPicker(videos) {
  const w = window.open('', '_blank', 'width=400,height=300');
  w.document.title = 'Debug Helper - Pick video';
  w.document.body.style.cssText = 'margin:0;padding:12px;font-family:system-ui;background:#1a1a1a;color:#eee';
  w.document.body.innerHTML = '<h3 style="margin:0 0 8px">Pick a video</h3><div id="list" style="display:flex;flex-direction:column;gap:6px"></div>';
  const list = w.document.getElementById('list');
  videos.forEach((v, i) => {
    const ts = new Date(v.timestamp).toLocaleString();
    const btn = w.document.createElement('button');
    btn.textContent = `Video ${i + 1} — ${ts}`;
    btn.style.cssText = 'padding:8px 12px;background:#0ea5e9;color:white;border:none;border-radius:4px;cursor:pointer;text-align:left';
    btn.addEventListener('click', () => {
      w.close();
      openVideoPopup(v);
    });
    list.appendChild(btn);
  });
}

$('#btn-copy').addEventListener('click', async () => {
  if (!lastExportText) return;
  try {
    await navigator.clipboard.writeText(lastExportText);
    $('#btn-copy').textContent = 'Copied!';
  } catch {
    // Fallback: select the pre text
    const range = document.createRange();
    range.selectNodeContents($('#export-preview'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    $('#btn-copy').textContent = 'Copied!';
  }
  setTimeout(() => $('#btn-copy').textContent = 'Copy to Clipboard', 1500);
});

$('#btn-download').addEventListener('click', async () => {
  if (!lastExportText || !currentSessionId) return;
  const btn = $('#btn-download');
  const filters = getExportFilters();
  const formatMap = { md: 'markdown', json: 'json', toon: 'toon' };
  const format = formatMap[lastExportFormat] || 'json';

  if (filters.screenshotAsFile) {
    // Download as ZIP (report + screenshot files)
    btn.textContent = 'Building ZIP...';
    btn.disabled = true;
    try {
      const result = await send({ type: 'export:zip', sessionId: currentSessionId, format, filters });
      if (result?.zipDataUrl) {
        const a = document.createElement('a');
        a.href = result.zipDataUrl;
        a.download = result.filename;
        a.click();
      }
    } finally {
      btn.textContent = 'Download ZIP';
      btn.disabled = false;
    }
  } else {
    // Download single file
    const ext = lastExportFormat;
    const mimeTypes = { json: 'application/json', md: 'text/markdown', toon: 'text/toon' };
    const blob = new Blob([lastExportText], { type: mimeTypes[ext] || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debug-report-${currentSessionId}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }
});

// Event-driven feed updates via storage change listener
chrome.storage.onChanged.addListener((changes) => {
  const sid = currentSessionId;

  // Append new events to feed reactively (no full re-render)
  if (sid) {
    for (const key of Object.keys(changes)) {
      if (key.startsWith('events:' + sid + ':') && changes[key].newValue) {
        const newEvents = changes[key].newValue;
        // Only process events we haven't seen (compare with oldValue)
        const oldEvents = changes[key].oldValue || [];
        const added = newEvents.slice(oldEvents.length);
        if (added.length > 0) {
          const feed = $('#feed');
          let hasScreenshot = false;
          added.forEach(ev => {
            feed.appendChild(renderEvent(ev));
            knownEventCount++;
            if (ev.type === 'event:screenshot' || ev.type === 'event:video') hasScreenshot = true;
          });
          applyFilter();
          if (autoScroll) $('#tab-feed').scrollTop = $('#tab-feed').scrollHeight;
          // Refresh gallery when new media events arrive
          if (hasScreenshot) loadScreenshots();
          // Refresh timeline ticks (capped at 200, cheap)
          renderRangeTimelineFromFeed();
        }
      }
    }
  }

  // Refresh session state on session changes
  if (Object.keys(changes).some(k => k.startsWith('session:') || k === 'currentSessionId')) {
    loadSessionState();
    loadHistory();
    loadScreenshots();
  }
});

// Lightweight session state update (no feed re-render)
async function loadSessionState() {
  let state;
  try { state = await send({ type: 'session:get' }); } catch { return; }
  const statusEl = $('#status');
  const noteBar = $('#note-bar');
  const onFeedTab = document.querySelector('.tab[data-tab="feed"]')?.classList.contains('active');

  if (state.recording) {
    statusEl.textContent = 'Recording';
    statusEl.className = 'status-badge recording';
    activeSessionId = state.session.id;
    if (currentSessionId !== state.session.id) {
      currentSessionId = state.session.id;
      rangeSessionStart = state.session.startTime;
      clearRange(); // range from old session is meaningless
      viewingHistorical = false;
      knownEventCount = 0;
      $('#feed').innerHTML = '';
      // Auto-enable auto-scroll when new recording starts
      autoScroll = true;
      const scrollBtn = $('#btn-autoscroll');
      scrollBtn.textContent = 'Auto ↓';
      scrollBtn.classList.remove('paused');
    }
    if (onFeedTab) noteBar.classList.remove('hidden');
  } else if (state.session) {
    noteBar.classList.add('hidden');
    if (activeSessionId && activeSessionId === state.session.id && state.session.endTime) {
      statusEl.textContent = 'Session ended';
      statusEl.className = 'status-badge';
      activeSessionId = null;
      loadHistory();
    } else if (!viewingHistorical) {
      statusEl.textContent = state.session.endTime ? 'Last session' : 'Idle';
      statusEl.className = 'status-badge';
    } else {
      statusEl.textContent = 'Viewing history';
      statusEl.className = 'status-badge';
    }
  } else {
    statusEl.textContent = viewingHistorical ? 'Viewing history' : 'Idle';
    statusEl.className = 'status-badge';
    activeSessionId = null;
    noteBar.classList.add('hidden');
  }
  updateRecordButton();
}

// Initial load — check if popup requested a specific session
(async () => {
  initRangeTimelineDrag();
  const { viewSessionId } = await chrome.storage.local.get('viewSessionId');
  if (viewSessionId) {
    await chrome.storage.local.remove('viewSessionId');
    viewSession(viewSessionId);
  } else {
    loadFeed();
    loadScreenshots();
  }
  loadHistory();
})();
