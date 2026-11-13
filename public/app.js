(function () {
  'use strict';

  var SESSION_KEY = 'devops_tutor_session_id';
  var CACHE_PREFIX = 'devops_tutor_cache_';
  var PROGRESS_KEY = 'devops_tutor_progress';
  var THEME_KEY = 'devops_tutor_theme';
  var COLLAPSED_KEY = 'devops_tutor_collapsed';
  var EXPORT_VERSION = 'v4.0';

  var sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  var topicCache = new Map();
  var progress = {};
  var lastStreamCached = false;
  var collapsedMonths = {};
  var currentTopic = null;
  var currentTopicId = null;
  var currentProject = null;
  var mode = 'topic';
  var isLoading = false;
  var currentAbort = null;
  var userScrolled = false;

  var $ = function (id) { return document.getElementById(id); };
  var chatEl = $('chat'), inputEl = $('input'), btnSend = $('btnSend'), btnCancel = $('btnCancel');
  var btnTask = $('btnTask'), btnQuiz = $('btnQuiz'), btnRefresh = $('btnRefresh'), btnLearned = $('btnLearned');
  var btnDelete = $('btnDelete'), btnToc = $('btnToc'), btnTheme = $('btnTheme');
  var btnProjStep = $('btnProjStep'), btnProjReset = $('btnProjReset'), btnProjExport = $('btnProjExport');
  var btnExport = $('btnExport'), btnImport = $('btnImport'), btnCleanCache = $('btnCleanCache');
  var fileImport = $('fileImport'), topicTitle = $('topicTitle'), topicMeta = $('topicMeta');
  var saveIndicator = $('saveIndicator'), tokensInfo = $('tokensInfo'), toastEl = $('toast');
  var tocEl = $('toc'), tocList = $('toc-list'), sidebar = $('sidebar'), searchEl = $('search'), burger = $('burger');
  var modalBg = $('modalBg'), modalTitle = $('modalTitle'), modalText = $('modalText'), modalOk = $('modalOk'), modalCancel = $('modalCancel');
  var progressFill = $('progressFill'), progressLabel = $('progressLabel');

  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast(e.name === 'QuotaExceededError' ? 'Хранилище переполнено. Очистите кеш.' : 'Не удалось сохранить локально: ' + e.message, 5000); } }
  function toast(msg, ms) { ms = ms || 2500; toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, ms); }
  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ---------- Markdown + syntax highlight ----------
  var BT = String.fromCharCode(96);
  var BT3 = BT + BT + BT;
  var LANG_KW = {
    bash: ['if','then','else','elif','fi','for','while','do','done','case','esac','function','in','return','echo','export','local','readonly','sudo','apt','yum','cd','ls','cp','mv','rm','mkdir','chmod','chown','git','docker','kubectl','systemctl','systemd','ps','grep','awk','sed','curl','wget','tar','zip','unzip','ssh','scp'],
    yaml: ['apiVersion','kind','metadata','spec','name','namespace','labels','annotations','containers','image','ports','replicas','selector','template','matchLabels','env','volumeMounts','volumes','resources','limits','requests','service','ingress','configMap','secret','true','false','null'],
    js: ['const','let','var','function','return','if','else','for','while','class','new','this','async','await','try','catch','throw','import','export','default','from','of','in','typeof','instanceof','null','undefined','true','false'],
    py: ['def','class','return','if','elif','else','for','while','try','except','finally','import','from','as','with','lambda','yield','global','nonlocal','True','False','None','and','or','not','in','is'],
    json: ['true','false','null'],
    sql: ['SELECT','FROM','WHERE','INSERT','UPDATE','DELETE','JOIN','LEFT','RIGHT','INNER','GROUP','BY','ORDER','HAVING','LIMIT','CREATE','TABLE','INDEX','ALTER','DROP','VALUES','INTO','SET','AND','OR','NOT','NULL','AS','ON'],
    go: ['package','import','func','var','const','type','struct','interface','return','if','else','for','range','switch','case','default','go','defer','chan','map','make','new','nil','true','false'],
    docker: ['FROM','RUN','CMD','ENTRYPOINT','COPY','ADD','WORKDIR','EXPOSE','ENV','ARG','VOLUME','USER','LABEL','HEALTHCHECK','ONBUILD','AS']
  };

  function highlight(code, lang) {
    var kws = LANG_KW[lang] || LANG_KW.bash;
    var esc = code; // уже экранировано выше
    // Комментарии
    esc = esc.replace(/(^|\n)(\s*#[^\n]*)/g, '$1<span class="tok-com">$2</span>');
    esc = esc.replace(/(^|\n)(\s*\/\/[^\n]*)/g, '$1<span class="tok-com">$2</span>');
    // Строки
    esc = esc.replace(/(&quot;[^&\n]*?&quot;|&#39;[^&\n]*?&#39;)/g, '<span class="tok-str">$1</span>');
    // Числа
    esc = esc.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
    // Ключевые слова
    var re = new RegExp('\\b(' + kws.map(function(k){return k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}).join('|') + ')\\b', 'g');
    esc = esc.replace(re, '<span class="tok-kw">$1</span>');
    return esc;
  }

  function renderMarkdown(text) {
    var CB_O = '\u0001CBO\u0001', CB_C = '\u0001CBC\u0001';
    var IC_O = '\u0001ICO\u0001', IC_C = '\u0001ICC\u0001';

    var s = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    var blocks = [];
    var reBlock = new RegExp(BT3 + '([a-zA-Z0-9_+\\-]*)[\\r\\n]?([\\s\\S]*?)' + BT3, 'g');
    s = s.replace(reBlock, function (m, lang, code) {
      var i = blocks.length;
      blocks.push({ lang: (lang || '').toLowerCase(), code: code.replace(/\n$/, '') });
      return CB_O + i + CB_C;
    });

    var inlines = [];
    var reInline = new RegExp(BT + '([^' + BT + '\\r\\n]+)' + BT, 'g');
    s = s.replace(reInline, function (m, code) {
      var i = inlines.length;
      inlines.push(code);
      return IC_O + i + IC_C;
    });

    // Заголовки: markdown (#) и «эмодзи-заголовки», которые просит модель.
    s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^([\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}]️?)\s+([^\n<]{2,80})$/gmu, function (m, emo, title) {
      return '<h3>' + emo + ' ' + title + '</h3>';
    });
    s = s.replace(/\*\*([^*\r\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\r\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    s = s.replace(/((?:^\|.+\|$\r?\n?){2,})/gm, function (table) {
      var lines = table.trim().split(/\r?\n/);
      if (lines.length < 2) return table;
      if (!/^\|[\s\-:|]+\|$/.test(lines[1].trim())) return table;
      var head = lines[0].trim().slice(1, -1).split('|').map(function(c){return c.trim();});
      var html = '<table><thead><tr>' + head.map(function(c){return '<th>'+c+'</th>';}).join('') + '</tr></thead><tbody>';
      for (var i = 2; i < lines.length; i++) {
        var cells = lines[i].trim().slice(1, -1).split('|').map(function(c){return c.trim();});
        html += '<tr>' + cells.map(function(c){return '<td>'+c+'</td>';}).join('') + '</tr>';
      }
      return html + '</tbody></table>';
    });

    s = s.replace(/^(?:[-*]) (.+)$/gm, '<li>$1</li>');
    s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
    s = s.replace(/^---$/gm, '<hr>');

    s = s.replace(new RegExp(IC_O + '(\\d+)' + IC_C, 'g'), function (m, i) { return '<code>' + inlines[+i] + '</code>'; });

    s = s.replace(new RegExp(CB_O + '(\\d+)' + CB_C, 'g'), function (m, i) {
      var b = blocks[+i];
      var htmlCode = highlight(b.code, b.lang);
      return '\n\n<pre><button class="copy-code" title="Копировать код">копировать</button><code>' + htmlCode + '</code></pre>\n\n';
    });

    // Готовые блоки (код, заголовки, списки, таблицы) временно заменяем
    // маркерами: иначе деление по пустым строкам залезет внутрь <pre>
    // и сломает код-блок, в котором есть пустые строки.
    var blockParts = [];
    s = s.replace(/<(pre|h3|h4|ul|table|blockquote)[\s\S]*?<\/\1>|<hr\s*\/?>/g, function (m) {
      var idx = blockParts.length;
      blockParts.push(m);
      return '\n\n@@B' + idx + '@@\n\n';
    });

    s = s.split(/\n{2,}/).map(function (part) {
      var t = part.trim();
      if (!t) return '';
      if (/^@@B\d+@@$/.test(t)) return t;
      return '<p>' + t + '</p>';
    }).filter(function (p) { return p; }).join('\n');

    s = s.replace(/@@B(\d+)@@/g, function (m, i) { return blockParts[+i]; });

    return s;
  }

  function attachCopyHandlers(root) {
    root.querySelectorAll('.copy-code').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var code = btn.closest('pre').querySelector('code');
        if (!code) return;
        if (!navigator.clipboard) { toast('Буфер обмена доступен только на localhost или HTTPS'); return; }
        navigator.clipboard.writeText(code.textContent).then(function () {
          btn.textContent = 'скопировано';
          setTimeout(function () { btn.textContent = 'копировать'; }, 1400);
        }).catch(function (e) {
          toast('Не удалось скопировать: ' + e.message);
        });
      });
    });
  }

  function addMsg(text, cls) {
    var d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = renderMarkdown(text);
    chatEl.appendChild(d);
    attachCopyHandlers(d);
    smartScroll(true);
    return d;
  }

  function smartScroll(force) { if (force || !userScrolled) chatEl.scrollTop = chatEl.scrollHeight; }
  chatEl.addEventListener('scroll', function () { userScrolled = !(chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80); });

  function clearChat() { chatEl.innerHTML = ''; }

  function setBusy(busy) {
    isLoading = busy;
    var hasTopic = !!currentTopic;
    var hasProject = !!currentProject;
    var inProjectMode = (mode === 'project');
    btnTask.disabled = busy || !hasTopic || inProjectMode;
    btnQuiz.disabled = busy || !hasTopic || inProjectMode;
    btnRefresh.disabled = busy || !hasTopic || inProjectMode;
    btnLearned.disabled = busy || !hasTopic || inProjectMode;
    btnDelete.disabled = busy || !hasTopic || inProjectMode;
    btnToc.disabled = !hasTopic && !hasProject;
    btnSend.disabled = busy || (!hasTopic && !hasProject);
    inputEl.disabled = busy || (!hasTopic && !hasProject);
    btnCancel.style.display = busy ? 'inline-block' : 'none';
    btnProjStep.style.display = (inProjectMode && hasProject) ? 'inline-block' : 'none';
    btnProjReset.style.display = (inProjectMode && hasProject) ? 'inline-block' : 'none';
    btnProjExport.style.display = (inProjectMode && hasProject) ? 'inline-block' : 'none';
    btnProjStep.disabled = busy || !hasProject;
    btnProjReset.disabled = busy || !hasProject;
    btnProjExport.disabled = busy || !hasProject;
  }

  function setSaveIndicator(text, ttl) { saveIndicator.textContent = text; if (ttl) setTimeout(function () { if (saveIndicator.textContent === text) saveIndicator.textContent = ''; }, ttl); }
  function clearTokensHint() { tokensInfo.textContent = ''; }

  // ---------- Progress ----------
  function loadProgress() { progress = lsGet(PROGRESS_KEY) || {}; }
  function saveProgress() { lsSet(PROGRESS_KEY, progress); }
  function setProgress(topicId, state) {
    progress[topicId] = state;
    saveProgress();
    updateDot(topicId, state);
    setSaveIndicator('сохранено', 1500);
    fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: progress }) })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        refreshStats();
      })
      .catch(function (e) {
        setSaveIndicator('только локально', 3000);
        toast('Прогресс сохранён локально, сервер недоступен: ' + e.message, 4000);
      });
  }
  function updateDot(topicId, state) {
    var el = document.querySelector('.topic[data-id="' + topicId + '"] .dot');
    if (!el) return;
    el.classList.remove('learned', 'progress');
    if (state === 'learned') el.classList.add('learned');
    else if (state === 'progress') el.classList.add('progress');
  }
  function refreshStats() {
    fetch('/api/stats').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (!s) return;
      progressFill.style.width = s.percent + '%';
      progressLabel.textContent = s.learned + ' / ' + s.total + ' изучено (' + s.percent + '%)';
    }).catch(function () {});
  }

  // ---------- Cache ----------
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf(CACHE_PREFIX) === 0) {
      var tid = k.slice(CACHE_PREFIX.length);
      var val = lsGet(k);
      if (val && Array.isArray(val)) topicCache.set(tid, val);
    }
  }
  function saveTopicCache(topicId, msgs) { topicCache.set(topicId, msgs); lsSet(CACHE_PREFIX + topicId, msgs); }
  function appendTopicCache(topicId, msg) { var a = topicCache.get(topicId) || []; a.push(msg); saveTopicCache(topicId, a); }
  function deleteTopicCache(topicId) { topicCache.delete(topicId); localStorage.removeItem(CACHE_PREFIX + topicId); }
  function renderFromCache(topicId) {
    var cached = topicCache.get(topicId);
    if (!cached || !cached.length) return false;
    clearChat();
    tokensInfo.textContent = 'из кеша';
    cached.forEach(function (m) {
      if (m.type === 'err') addMsg(m.text, 'err');
      else if (m.type === 'warn') addMsg(m.text, 'warn');
      else if (m.type === 'sys') addMsg(m.text, 'sys');
      else if (m.type === 'user') addMsg(m.text, 'user');
      else addMsg(m.text, 'ai');
    });
    buildToc();
    chatEl.scrollTop = 0;
    return true;
  }

  // ---------- TOC ----------
  function buildToc() {
    tocList.innerHTML = '';
    var headers = chatEl.querySelectorAll('.msg.ai h3');
    if (!headers.length) return;
    headers.forEach(function (h, idx) {
      var id = 'h_' + idx + '_' + Date.now();
      h.id = id;
      var a = document.createElement('a');
      a.href = '#' + id;
      a.textContent = h.textContent.slice(0, 70);
      a.onclick = function (e) { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      tocList.appendChild(a);
    });
  }

  // ---------- Streaming fetch ----------
  function streamFetch(url, body, onDelta, onDone, onError, onWarning, onContinuation) {
    var controller = new AbortController();
    currentAbort = controller;
    lastStreamCached = false;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.error || ('HTTP ' + response.status));
        });
      }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var pump = function () {
        return reader.read().then(function (r) {
          if (r.done) { onDone(); return; }
          buffer += decoder.decode(r.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data:')) continue;
            var payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              var j = JSON.parse(payload);
              if (j.error) {
                try { reader.cancel(); } catch (cancelError) { /* поток уже закрыт */ }
                onError(new Error(j.error));
                return;
              }
              if (j.cached) { lastStreamCached = true; tokensInfo.textContent = 'из кеша'; }
              if (j.warning && onWarning) onWarning(j.warning);
              if (j.continuation && onContinuation) onContinuation(j.continuation);
              if (j.delta) onDelta(j.delta);
              if (j.done) { onDone(); return; }
            } catch (e) { console.warn('Пропущен битый SSE-фрагмент:', e.message); }
          }
          return pump();
        });
      };
      return pump();
    }).catch(function (e) {
      if (e.name === 'AbortError') { onError({ aborted: true }); return; }
      onError(e);
    }).finally(function () { currentAbort = null; });
  }

  // ---------- API ----------
  function callExplain(topic, force) {
    clearChat();
    addMsg('Тема: ' + topic.title + ' (' + topic.level + ')', 'sys');
    var streamMsg = document.createElement('div');
    streamMsg.className = 'msg ai';
    streamMsg.innerHTML = '<span class="loader"></span>Генерирую урок...';
    chatEl.appendChild(streamMsg);
    smartScroll(true);
    var fullText = '';
    var started = false;
    var t0 = Date.now();
    tokensInfo.textContent = '';

    return streamFetch('/api/explain', { topicId: topic.id, sessionId: sessionId, force: !!force },
      function (delta) {
        if (!started) { started = true; streamMsg.innerHTML = ''; }
        fullText += delta;
        streamMsg.innerHTML = renderMarkdown(fullText);
        attachCopyHandlers(streamMsg);
        smartScroll();
      },
      function () {
        streamMsg.innerHTML = renderMarkdown(fullText);
        attachCopyHandlers(streamMsg);
        buildToc();
        saveTopicCache(topic.id, [{ type: 'sys', text: 'Тема: ' + topic.title + ' (' + topic.level + ')' }, { type: 'ai', text: fullText }]);
        if (!progress[topic.id]) setProgress(topic.id, 'progress');
        else updateDot(topic.id, progress[topic.id]);
        var dt = ((Date.now() - t0) / 1000).toFixed(1);
        var tk = Math.round(fullText.length / 4);
        if (lastStreamCached) {
          tokensInfo.textContent = 'из кеша';
          setSaveIndicator('из кеша', 3000);
        } else {
          tokensInfo.textContent = '~' + tk + ' ток · ' + dt + ' с';
          setSaveIndicator(dt + ' с', 3000);
          toast('Урок сохранён в кеш (' + dt + ' с)');
        }
      },
      function (err) {
        if (err.aborted) { streamMsg.innerHTML = renderMarkdown(fullText || ''); return; }
        streamMsg.className = 'msg err';
        streamMsg.textContent = (err.message || err);
      },
      function (warning) {
        var w = document.createElement('div');
        w.className = 'msg warn';
        w.textContent = warning;
        chatEl.insertBefore(w, streamMsg.nextSibling);
      },
      function (n) {
        // continuation  ничего не делаем визуально, просто продолжаем аппендить
      }
    );
  }

  function callAsk(question) {
    addMsg(question, 'user');
    appendTopicCache(currentTopicId, { type: 'user', text: question });
    var streamMsg = document.createElement('div');
    streamMsg.className = 'msg ai';
    streamMsg.innerHTML = '<span class="loader"></span>Отвечаю...';
    chatEl.appendChild(streamMsg);
    smartScroll(true);
    var fullText = '';
    var started = false;
    return streamFetch('/api/ask', { question: question, sessionId: sessionId },
      function (delta) { if (!started) { started = true; streamMsg.innerHTML = ''; } fullText += delta; streamMsg.innerHTML = renderMarkdown(fullText); attachCopyHandlers(streamMsg); smartScroll(); },
      function () { streamMsg.innerHTML = renderMarkdown(fullText); attachCopyHandlers(streamMsg); appendTopicCache(currentTopicId, { type: 'ai', text: fullText }); },
      function (err) {
        if (err.aborted) { streamMsg.innerHTML = renderMarkdown(fullText || ''); return; }
        streamMsg.className = 'msg err'; streamMsg.textContent = (err.message || err);
        appendTopicCache(currentTopicId, { type: 'err', text: 'Ошибка: ' + (err.message || err) });
      }
    );
  }

  function callTopicEndpoint(endpoint, label, isQuiz) {
    addMsg(label, 'user');
    appendTopicCache(currentTopicId, { type: 'user', text: label });
    var streamMsg = document.createElement('div');
    streamMsg.className = 'msg ai';
    streamMsg.innerHTML = '<span class="loader"></span>Генерирую...';
    chatEl.appendChild(streamMsg);
    smartScroll(true);
    var fullText = '';
    var started = false;
    return streamFetch(endpoint, { sessionId: sessionId },
      function (delta) { if (!started) { started = true; streamMsg.innerHTML = ''; } fullText += delta; streamMsg.innerHTML = renderMarkdown(fullText); attachCopyHandlers(streamMsg); smartScroll(); },
      function () {
        streamMsg.innerHTML = renderMarkdown(fullText);
        attachCopyHandlers(streamMsg);
        appendTopicCache(currentTopicId, { type: 'ai', text: fullText });
        if (isQuiz && currentTopicId) {
          setProgress(currentTopicId, 'learned');
          toast('Тема отмечена как изученная');
        }
      },
      function (err) {
        if (err.aborted) { streamMsg.innerHTML = renderMarkdown(fullText || ''); return; }
        streamMsg.className = 'msg err'; streamMsg.textContent = (err.message || err);
      }
    );
  }

  // ---------- Roadmap ----------
  function loadRoadmap() {
    return fetch('/api/roadmap').then(function (r) { return r.json(); }).then(function (data) {
      var container = $('roadmap');
      container.innerHTML = '';
      data.months.forEach(function (m) {
        var mt = document.createElement('div');
        mt.className = 'month-title';
        mt.textContent = m.title;
        mt.dataset.month = m.month;
        if (collapsedMonths[m.month]) mt.classList.add('collapsed');
        mt.onclick = function () {
          var isCollapsed = mt.classList.toggle('collapsed');
          collapsedMonths[m.month] = isCollapsed;
          lsSet(COLLAPSED_KEY, collapsedMonths);
          var wrap = mt.nextElementSibling;
          if (wrap && wrap.classList.contains('month-topics')) wrap.classList.toggle('hidden', isCollapsed);
        };
        container.appendChild(mt);

        var wrap = document.createElement('div');
        wrap.className = 'month-topics';
        if (collapsedMonths[m.month]) wrap.classList.add('hidden');

        m.topics.forEach(function (t) {
          var el = document.createElement('div');
          el.className = 'topic';
          el.dataset.id = t.id;
          el.dataset.search = (t.title + ' ' + t.description + ' ' + t.level).toLowerCase();
          var prog = progress[t.id] || '';
          var dotCls = prog === 'learned' ? 'learned' : (prog === 'progress' ? 'progress' : '');
          var lvlLetter = (t.level || '').charAt(0).toUpperCase();
          el.innerHTML = '<span class="dot ' + dotCls + '"></span><span class="title">' + escapeHtml(t.title) + '</span><span class="lvl" title="' + escapeHtml(t.level) + '">' + lvlLetter + '</span>';
          el.title = t.description;
          el.onclick = function () { selectTopic(t); };
          wrap.appendChild(el);
        });
        container.appendChild(wrap);

        var pcard = document.createElement('div');
        pcard.className = 'project-card';
        pcard.dataset.month = m.month;
        pcard.innerHTML = '<span class="p-icon"></span><span class="p-label">Проект месяца</span><span class="p-status"></span>';
        pcard.onclick = function () { openProject(m.month); };
        container.appendChild(pcard);
      });
    });
  }

  function refreshAllProjectCards() {
    document.querySelectorAll('.project-card').forEach(function (el) {
      refreshProjectCard(parseInt(el.dataset.month, 10));
    });
  }

  function refreshProjectCard(monthId) {
    var el = document.querySelector('.project-card[data-month="' + monthId + '"]');
    if (!el) return;
    fetch('/api/project/' + monthId + '?sessionId=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) { el.querySelector('.p-status').textContent = ''; return; }
        var p = data.project;
        var status = el.querySelector('.p-status');
        var icon = el.querySelector('.p-icon');
        el.classList.remove('locked');
        if (!data.allLearned) {
          el.classList.add('locked');
          icon.textContent = '';
          status.textContent = data.learned + '/' + data.total + ' тем';
        } else if (!p.plan) {
          icon.textContent = '';
          status.textContent = 'готов начать';
        } else if (p.status === 'plan_ready' || p.status === 'not_started') {
          icon.textContent = '';
          status.textContent = 'план готов';
        } else if (p.status === 'in_progress') {
          icon.textContent = '';
          status.textContent = 'шаг ' + p.currentStep + '/' + (p.totalSteps || '?');
        } else if (p.status === 'completed') {
          icon.textContent = '';
          status.textContent = 'завершён';
        } else {
          icon.textContent = '';
          status.textContent = p.status || '';
        }
      })
      .catch(function () {});
  }

  function openProject(monthId) {
    if (isLoading) { toast('Подожди, идёт запрос...'); return; }
    fetch('/api/project/' + monthId + '?sessionId=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) { toast('Не удалось загрузить проект'); return; }
        if (!data.allLearned) { toast('Сначала закончи темы месяца: ' + data.missing.join(', '), 4500); return; }
        enterProjectMode(data);
      })
      .catch(function () { toast('Ошибка загрузки проекта'); });
  }

  function enterProjectMode(data) {
    mode = 'project';
    currentProject = { month: data.month.month, title: data.month.title, project: data.project };
    currentTopic = null;
    currentTopicId = null;
    document.querySelectorAll('.topic').forEach(function (el) { el.classList.remove('active'); });
    document.querySelectorAll('.project-card').forEach(function (el) {
      el.classList.toggle('active', parseInt(el.dataset.month, 10) === data.month.month);
    });
    topicTitle.textContent = 'Проект: ' + data.month.title;
    var p = data.project;
    if (p.plan && p.status === 'in_progress') topicMeta.textContent = 'шаг ' + p.currentStep + ' / ' + (p.totalSteps || '?');
    else if (p.plan) topicMeta.textContent = 'план готов, ждём старта';
    else topicMeta.textContent = 'проект ещё не запущен';
    setBusy(false);
    renderProject(p, data.month);
  }

  function renderProject(p, month) {
    clearChat();
    if (!p.plan) {
      var w = document.createElement('div');
      w.className = 'welcome';
      w.innerHTML = '<div class="welcome-mark">§</div><h2>' + escapeHtml(month.title) + '</h2><p>Итоговый проект по этому месяцу. Нажмите «Начать проект» — наставник спроектирует практику на основе изученных тем.</p>';
      chatEl.appendChild(w);
      var b = document.createElement('button');
      b.className = 'primary';
      b.style.marginTop = '20px';
      b.textContent = 'Начать проект';
      b.onclick = function () { startProjectFlow(false); };
      w.appendChild(b);
      return;
    }
    addMsg('Проект месяца ' + month.month + ': ' + month.title, 'sys');
    p.history.forEach(function (m) {
      if (m.role === 'user') addMsg(m.content, 'user');
      else addMsg(m.content, 'ai');
    });
    buildToc();
    if (p.status === 'plan_ready') addMsg('Скажи «поехали» — начнём с шага 1.', 'sys');
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function startProjectFlow(force) {
    setBusy(true);
    clearChat();
    addMsg('Проект: ' + (currentProject ? currentProject.title : ''), 'sys');
    var streamMsg = document.createElement('div');
    streamMsg.className = 'msg ai';
    streamMsg.innerHTML = '<span class="loader"></span>Готовлю проект...';
    chatEl.appendChild(streamMsg);
    var fullText = '';
    var started = false;
    return streamFetch('/api/project/start',
      { sessionId: sessionId, monthId: currentProject.month, force: !!force },
      function (delta) {
        if (!started) { started = true; streamMsg.innerHTML = ''; }
        fullText += delta;
        streamMsg.innerHTML = renderMarkdown(fullText);
        attachCopyHandlers(streamMsg);
        smartScroll();
      },
      function () {
        streamMsg.innerHTML = renderMarkdown(fullText);
        attachCopyHandlers(streamMsg);
        buildToc();
        refreshProjectCard(currentProject.month);
        fetch('/api/project/' + currentProject.month + '?sessionId=' + encodeURIComponent(sessionId))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.project) {
              currentProject.project = data.project;
              topicMeta.textContent = 'шаг ' + data.project.currentStep + ' / ' + (data.project.totalSteps || '?');
              if (data.project.status === 'plan_ready') addMsg('Скажи «поехали» — начнём с шага 1.', 'sys');
            }
          })
          .catch(function () {});
        toast('Проект сгенерирован и сохранён');
      },
      function (err) {
        if (err.aborted) { streamMsg.innerHTML = renderMarkdown(fullText || ''); return; }
        streamMsg.className = 'msg err';
        streamMsg.textContent = (err.message || err);
      }
    ).finally(function () { setBusy(false); });
  }

  function sendProjectMessage(text, markStepDone) {
    addMsg(text, 'user');
    var streamMsg = document.createElement('div');
    streamMsg.className = 'msg ai';
    streamMsg.innerHTML = '<span class="loader"></span>Думаю...';
    chatEl.appendChild(streamMsg);
    var fullText = '';
    var started = false;
    return streamFetch('/api/project/ask',
      { sessionId: sessionId, monthId: currentProject.month, question: text, markStepDone: !!markStepDone },
      function (delta) {
        if (!started) { started = true; streamMsg.innerHTML = ''; }
        fullText += delta;
        streamMsg.innerHTML = renderMarkdown(fullText);
        attachCopyHandlers(streamMsg);
        smartScroll();
      },
      function () {
        streamMsg.innerHTML = renderMarkdown(fullText);
        attachCopyHandlers(streamMsg);
        refreshProjectCard(currentProject.month);
        fetch('/api/project/' + currentProject.month + '?sessionId=' + encodeURIComponent(sessionId))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.project) {
              currentProject.project = data.project;
              topicMeta.textContent = 'шаг ' + data.project.currentStep + ' / ' + (data.project.totalSteps || '?');
            }
          })
          .catch(function () {});
      },
      function (err) {
        if (err.aborted) { streamMsg.innerHTML = renderMarkdown(fullText || ''); return; }
        streamMsg.className = 'msg err';
        streamMsg.textContent = (err.message || err);
      }
    );
  }

  function filterRoadmap() {
    var q = searchEl.value.trim().toLowerCase();
    var found = 0;
    document.querySelectorAll('.topic').forEach(function (el) {
      var match = !q || el.dataset.search.indexOf(q) !== -1;
      el.classList.toggle('hidden', !match);
      if (match) found++;
    });
    document.querySelectorAll('.month-title').forEach(function (mt) {
      var wrap = mt.nextElementSibling;
      if (!wrap) return;
      var anyVisible = wrap.querySelector('.topic:not(.hidden)');
      mt.style.display = (q && !anyVisible) ? 'none' : '';
      if (q && anyVisible && mt.classList.contains('collapsed')) {
        mt.classList.remove('collapsed');
        wrap.classList.remove('hidden');
      }
    });
    var empty = document.getElementById('emptySearch');
    if (q && !found) {
      if (!empty) { empty = document.createElement('div'); empty.id = 'emptySearch'; empty.className = 'empty-search'; empty.textContent = 'Ничего не найдено'; $('roadmap').appendChild(empty); }
    } else if (empty) { empty.remove(); }
  }

  function selectTopic(topic) {
    if (isLoading) { toast('Подожди, идёт запрос...'); return; }
    if (mode === 'project') {
      mode = 'topic';
      currentProject = null;
      document.querySelectorAll('.project-card').forEach(function (el) { el.classList.remove('active'); });
    }
    userScrolled = false;
    currentTopic = topic;
    currentTopicId = topic.id;
    document.querySelectorAll('.topic').forEach(function (el) { el.classList.toggle('active', el.dataset.id === topic.id); });
    topicTitle.textContent = topic.title;
    topicMeta.textContent = topic.level + ' · ' + topic.description;
    setBusy(false);

    // Если есть локальный кеш  рендерим мгновенно, но всё равно дёргаем сервер, чтобы синхронизировать сессию (без токенов)
    if (topicCache.has(topic.id)) {
      renderFromCache(topic.id);
      updateLearnedBtn();
      // Синхронизация серверной сессии (cache-hit, 0 токенов)
      fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId: topic.id, sessionId: sessionId }) })
        .catch(function (e) { console.warn('Не удалось синхронизировать сессию:', e.message); });
      return;
    }
    setBusy(true);
    callExplain(topic, false).finally(function () { setBusy(false); });
  }

  function updateLearnedBtn() {
    if (!currentTopicId) return;
    var st = progress[currentTopicId];
    btnLearned.textContent = st === 'learned' ? 'Изучено' : 'Пометить';
  }

  // ---------- Modal ----------
  function showModal(title, text, onOk) {
    modalTitle.textContent = title;
    modalText.textContent = text;
    modalBg.classList.add('open');
    var close = function () { modalBg.classList.remove('open'); modalOk.onclick = null; modalCancel.onclick = null; };
    modalOk.onclick = function () { close(); onOk && onOk(); };
    modalCancel.onclick = close;
  }

  // ---------- Events ----------
  btnSend.onclick = function () {
    var q = inputEl.value.trim();
    if (!q || isLoading) return;
    if (mode === 'project') {
      if (!currentProject) return;
      inputEl.value = '';
      inputEl.style.height = 'auto';
      setBusy(true);
      sendProjectMessage(q, false).finally(function () { setBusy(false); });
      return;
    }
    if (!currentTopic) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    setBusy(true);
    callAsk(q).finally(function () { setBusy(false); });
  };

  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); btnSend.click(); }
  });

  btnTask.onclick = function () { if (!isLoading && currentTopic) { setBusy(true); callTopicEndpoint('/api/task', 'Дай практическое задание').finally(function () { setBusy(false); }); } };
  btnQuiz.onclick = function () { if (!isLoading && currentTopic) { setBusy(true); callTopicEndpoint('/api/quiz', 'Проведи тест по теме', true).finally(function () { setBusy(false); }); } };
  btnCancel.onclick = function () { if (currentAbort) { try { currentAbort.abort(); } catch (e) {} toast('Запрос отменён'); } };

  btnProjStep.onclick = function () {
    if (isLoading || mode !== 'project' || !currentProject) return;
    setBusy(true);
    sendProjectMessage('Шаг выполнен. Проверь и дай следующий.', true).finally(function () { setBusy(false); });
  };

  btnProjReset.onclick = function () {
    if (isLoading || mode !== 'project' || !currentProject) return;
    showModal('Перезапустить проект?', 'План, вся история и шаги будут удалены. Токены потратятся заново.', function () {
      fetch('/api/project/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, monthId: currentProject.month })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        currentProject.project = { plan: null, history: [], currentStep: 1, totalSteps: 0, status: 'not_started', completedSteps: [] };
        refreshProjectCard(currentProject.month);
        renderProject(currentProject.project, { month: currentProject.month, title: currentProject.title });
        topicMeta.textContent = 'проект ещё не запущен';
      }).catch(function (e) {
        toast('Не удалось перезапустить проект: ' + e.message, 4000);
      });
    });
  };

  btnProjExport.onclick = function () {
    if (!currentProject) return;
    window.location.href = '/api/project/' + currentProject.month + '/export?sessionId=' + encodeURIComponent(sessionId);
  };

  btnRefresh.onclick = function () {
    if (isLoading || !currentTopic) return;
    showModal('Сгенерировать заново?', 'Старое объяснение будет перезаписано. Это потратит токены.', function () {
      deleteTopicCache(currentTopic.id);
      fetch('/api/reset-topic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId, topicId: currentTopic.id }) })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
        .catch(function (e) { toast('Не удалось сбросить тему: ' + e.message, 4000); })
        .finally(function () { setBusy(true); callExplain(currentTopic, true).finally(function () { setBusy(false); }); });
    });
  };

  btnLearned.onclick = function () {
    if (!currentTopicId) return;
    var cur = progress[currentTopicId];
    var next = cur === 'learned' ? 'progress' : 'learned';
    setProgress(currentTopicId, next);
    updateLearnedBtn();
    toast(next === 'learned' ? 'Отмечено как изученное' : 'Отмечено как в процессе');
  };

  btnDelete.onclick = function () {
    if (!currentTopicId || isLoading) return;
    var id = currentTopicId;
    var title = currentTopic ? currentTopic.title : '';
    showModal('Удалить тему?', 'Тема «' + title + '»: кеш урока, история диалога и отметка прогресса будут удалены.', function () {
      deleteTopicCache(id);
      delete progress[id];
      saveProgress();
      fetch('/api/delete-topic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId, topicId: id }) })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress: progress }) });
        })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          toast('Тема удалена');
          setTimeout(function () { location.reload(); }, 700);
        })
        .catch(function (e) {
          toast('Не удалось удалить тему: ' + e.message, 4000);
        });
    });
  };

  btnCleanCache.onclick = function () {
    showModal('Очистить весь кеш?', 'Все сгенерированные уроки будут удалены. При следующем открытии темы токены будут потрачены заново.', function () {
      fetch('/api/clean-cache', { method: 'POST' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
        }
        keys.forEach(function (k) { localStorage.removeItem(k); });
        toast('Кеш очищен. Обновите страницу.');
        setTimeout(function () { location.reload(); }, 900);
      }).catch(function (e) {
        toast('Не удалось очистить кеш: ' + e.message, 4000);
      });
    });
  };

  btnToc.onclick = function () { tocEl.classList.toggle('open'); };
  document.addEventListener('click', function (e) {
    if (tocEl.classList.contains('open') && !tocEl.contains(e.target) && e.target !== btnToc && !btnToc.contains(e.target)) tocEl.classList.remove('open');
  });

  btnTheme.onclick = function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
  };

  btnExport.onclick = function () {
    var data = { version: EXPORT_VERSION, exportedAt: Date.now(), progress: progress, cache: {} };
    topicCache.forEach(function (v, k) { data.cache[k] = v; });
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'devops-tutor-progress-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Экспортировано');
  };

  btnImport.onclick = function () { fileImport.click(); };
  fileImport.onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (data.progress) { progress = Object.assign({}, progress, data.progress); saveProgress(); }
        if (data.cache) {
          Object.keys(data.cache).forEach(function (k) { if (Array.isArray(data.cache[k])) saveTopicCache(k, data.cache[k]); });
        }
        var afterImport = function (note) {
          toast(note || 'Импортировано. Обновите страницу.');
          setTimeout(function () { location.reload(); }, 900);
        };
        if (data.projects) {
          fetch('/api/project/import', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projects: data.projects })
          }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          }).then(function (res) {
            afterImport(res.skipped ? 'Импортировано, пропущено проектов: ' + res.skipped : null);
          }).catch(function (e) {
            toast('Прогресс импортирован, проекты — нет: ' + e.message, 5000);
            setTimeout(function () { location.reload(); }, 1200);
          });
        } else {
          afterImport();
        }
      } catch (err) { toast('Ошибка: ' + err.message, 4000); }
    };
    reader.readAsText(f);
  };

  // Экспорт текущего урока в Markdown
  function exportCurrentAsMarkdown() {
    if (!currentTopicId) return;
    var cached = topicCache.get(currentTopicId);
    if (!cached) return;
    var md = '# ' + (currentTopic ? currentTopic.title : currentTopicId) + '\n\n';
    cached.forEach(function (m) {
      if (m.type === 'ai') md += m.text + '\n\n---\n\n';
      else if (m.type === 'user') md += '> ' + m.text + '\n\n';
    });
    var blob = new Blob([md], { type: 'text/markdown' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = currentTopicId + '.md';
    a.click();
    URL.revokeObjectURL(url);
    toast('Урок экспортирован в Markdown');
  }
  window.exportCurrentAsMarkdown = exportCurrentAsMarkdown;

  burger.onclick = function () { sidebar.classList.toggle('open'); };

  var searchTimer = null;
  searchEl.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(filterRoadmap, 150);
  });

  // Shortcuts
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === 'k') { e.preventDefault(); searchEl.focus(); }
    if (e.ctrlKey && e.key === 'e') { e.preventDefault(); exportCurrentAsMarkdown(); }
    if (e.key === 'Escape') {
      if (isLoading && currentAbort) { currentAbort.abort(); toast('Запрос отменён'); }
      else if (modalBg.classList.contains('open')) modalBg.classList.remove('open');
      else if (tocEl.classList.contains('open')) tocEl.classList.remove('open');
    }
  });

  // ---------- Init ----------
  (function init() {
    var savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
    collapsedMonths = lsGet(COLLAPSED_KEY) || {};

    loadProgress();
    refreshStats();

    // Подтянуть серверный прогресс
    fetch('/api/progress').then(function (r) { return r.ok ? r.json() : null; }).then(function (sp) {
      if (sp) { progress = Object.assign({}, sp, progress); saveProgress(); }
    }).catch(function () {}).finally(function () {
      loadRoadmap().then(function () {
        refreshAllProjectCards();
        return fetch('/api/history/' + sessionId).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      }).then(function (hist) {
        if (hist && hist.currentTopicId) {
          var el = document.querySelector('.topic[data-id="' + hist.currentTopicId + '"]');
          if (el) el.click();
        }
      }).catch(function () {});
    });

    // Периодически обновлять stats (раз в минуту)
    setInterval(refreshStats, 60000);
  })();

})();
