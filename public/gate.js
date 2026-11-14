// Вход и регистрация. Загружается до app.js: основное приложение
// стартует только после подтверждённой сессии. Отдаёт window.PW —
// общие помощники для settings.js.
(function () {
  'use strict';

  var THEME_KEY = 'devops_tutor_theme';
  var USER_ID_KEY = 'pathwright_user_id';
  var USER_DATA_PREFIXES = [
    'devops_tutor_session_id',
    'devops_tutor_progress',
    'devops_tutor_cache_',
    'devops_tutor_collapsed'
  ];

  var state = {
    me: null,
    booted: false,
    authShown: false,
    loginCaptchaRequired: false,
    captcha: { login: null, register: null }
  };

  var $ = function (id) { return document.getElementById(id); };
  var authScreen = $('authScreen');
  var accountModal = $('settingsModal');
  var loginError = $('loginError');
  var registerError = $('registerError');

  try {
    var savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  } catch (e) { /* приватный режим */ }

  // ---------- Общие помощники ----------
  function api(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('HTTP ' + res.status));
          err.status = res.status;
          err.code = data.code;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function toast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('show'); }, ms || 3000);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(amount, currency) {
    return Number(amount).toLocaleString('ru-RU') + ' ' + (currency === 'RUB' ? '₽' : currency);
  }

  function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts)
      .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
      .replace(/\s*г\.$/, '');
  }

  function initial(name) {
    var s = String(name || 'P').trim();
    return s ? s.charAt(0).toUpperCase() : 'P';
  }

  // ---------- Локальные данные аккаунта ----------
  function clearUserData() {
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (!key) continue;
        for (var j = 0; j < USER_DATA_PREFIXES.length; j++) {
          if (key.indexOf(USER_DATA_PREFIXES[j]) === 0) { localStorage.removeItem(key); break; }
        }
      }
      localStorage.removeItem(USER_ID_KEY);
    } catch (e) { /* приватный режим */ }
  }

  function hasUserData() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i) || '';
        for (var j = 0; j < USER_DATA_PREFIXES.length; j++) {
          if (key.indexOf(USER_DATA_PREFIXES[j]) === 0) return true;
        }
      }
    } catch (e) { /* приватный режим */ }
    return false;
  }

  function syncLocalUser(userId, forceClear) {
    try {
      var stored = localStorage.getItem(USER_ID_KEY);
      if (forceClear || (stored && stored !== userId) || (!stored && hasUserData())) {
        clearUserData();
      }
      localStorage.setItem(USER_ID_KEY, userId);
    } catch (e) { /* приватный режим */ }
  }

  // ---------- Капча ----------
  function loadCaptcha(which) {
    var questionEl = $(which + 'CaptchaQ');
    if (questionEl) questionEl.textContent = '…';
    return api('/api/auth/captcha')
      .then(function (data) {
        state.captcha[which] = { id: data.id, answer: '' };
        if (questionEl) questionEl.textContent = data.question;
        var form = $(which + 'Form');
        // id дублируем в атрибут формы: вопрос на экране и id в запросе
        // всегда из одного ответа, даже если пришло два подряд.
        if (form) form.setAttribute('data-captcha-id', data.id);
        var input = form && form.captcha;
        if (input) input.value = '';
        return data;
      })
      .catch(function (err) {
        if (questionEl) questionEl.textContent = 'Не загрузилось';
        toast('Капча не загрузилась: ' + err.message, 4000);
      });
  }

  function captchaBody(which) {
    var form = $(which + 'Form');
    if (!form) return null;
    var id = form.getAttribute('data-captcha-id');
    var answer = form.captcha ? form.captcha.value.trim() : '';
    if (!id || !answer) return null;
    return { captchaId: id, captchaAnswer: answer };
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-captcha]'), function (btn) {
    btn.onclick = function () { loadCaptcha(btn.getAttribute('data-captcha')); };
  });

  // ---------- Показать/скрыть пароль ----------
  Array.prototype.forEach.call(document.querySelectorAll('[data-pw-toggle]'), function (btn) {
    btn.onclick = function () {
      var input = btn.parentNode.querySelector('input');
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Скрыть' : 'Показать';
      btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    };
  });

  // ---------- Индикатор надёжности пароля ----------
  function passwordScore(pw) {
    var score = 0;
    if (!pw) return 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-zа-я]/.test(pw) && /[A-ZА-Я]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^\w\s]/.test(pw)) score++;
    return Math.min(4, score);
  }

  var pwInput = document.querySelector('#registerForm input[name=password]');
  if (pwInput) {
    pwInput.addEventListener('input', function () {
      var score = passwordScore(pwInput.value);
      var bar = $('pwBar');
      var hint = $('pwHint');
      if (bar) {
        bar.style.width = (score / 4 * 100) + '%';
        bar.className = score <= 1 ? 'weak' : (score === 2 ? 'fair' : (score === 3 ? 'good' : 'strong'));
      }
      if (hint) {
        hint.textContent = [
          'Минимум 8 символов. Надёжнее — 12 и больше.',
          'Слабовато: добавьте длину.',
          'Нормально. Добавьте цифры и символы.',
          'Хороший пароль.',
          'Отличный пароль.'
        ][score];
      }
    });
  }

  // ---------- Экран входа ----------
  function showAuth() {
    document.body.classList.remove('pw-booting');
    authScreen.hidden = false;
    var first = document.querySelector('#authScreen input');
    if (first) setTimeout(function () { first.focus(); }, 50);
  }

  function hideAuth() {
    authScreen.hidden = true;
    document.body.classList.remove('pw-booting');
  }

  function loadScript(src, marker) {
    if (document.querySelector('script[' + marker + ']')) return;
    var s = document.createElement('script');
    s.src = src;
    s.defer = true;
    s.setAttribute(marker, '1');
    document.body.appendChild(s);
  }

  function loadApp() {
    if (state.booted) return;
    state.booted = true;
    loadScript('/app.js', 'data-pw-app');
    loadScript('/settings.js', 'data-pw-settings');
  }

  function switchTab(register) {
    $('tabLogin').classList.toggle('active', !register);
    $('tabRegister').classList.toggle('active', register);
    $('tabLogin').setAttribute('aria-selected', String(!register));
    $('tabRegister').setAttribute('aria-selected', String(register));
    $('loginForm').hidden = register;
    $('registerForm').hidden = !register;
    loginError.textContent = '';
    registerError.textContent = '';
    var form = register ? $('registerForm') : $('loginForm');
    var input = form.querySelector('input');
    if (input) input.focus();
  }

  $('tabLogin').onclick = function () { switchTab(false); };
  $('tabRegister').onclick = function () { switchTab(true); };

  $('loginForm').onsubmit = function (e) {
    e.preventDefault();
    var form = e.target;
    var email = form.email.value.trim();
    var password = form.password.value;
    loginError.textContent = '';
    if (!email || !password) { loginError.textContent = 'Заполните email и пароль'; return; }

    var body = { email: email, password: password };
    if (state.loginCaptchaRequired) {
      var cap = captchaBody('login');
      if (!cap) { loginError.textContent = 'Введите ответ на пример'; return; }
      body.captchaId = cap.captchaId;
      body.captchaAnswer = cap.captchaAnswer;
    }

    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    api('/api/auth/login', { method: 'POST', body: body })
      .then(function (data) { enter(data); })
      .catch(function (err) {
        if (err.code === 'CAPTCHA_REQUIRED') {
          state.loginCaptchaRequired = true;
          $('loginCaptchaRow').hidden = false;
          loadCaptcha('login');
          loginError.textContent = 'Введите ответ на пример — после нескольких неудачных попыток вход требует проверки.';
          return;
        }
        if (err.code === 'CAPTCHA_FAILED') loadCaptcha('login');
        loginError.textContent = err.message;
      })
      .finally(function () { btn.disabled = false; });
  };

  $('registerForm').onsubmit = function (e) {
    e.preventDefault();
    var form = e.target;
    var name = form.name.value.trim();
    var email = form.email.value.trim();
    var password = form.password.value;
    var password2 = form.password2.value;
    registerError.textContent = '';

    if (!name) { registerError.textContent = 'Введите имя'; return; }
    if (password.length < 8) { registerError.textContent = 'Пароль короче 8 символов'; return; }
    if (password !== password2) { registerError.textContent = 'Пароли не совпадают'; return; }
    if (!form.terms.checked) { registerError.textContent = 'Подтвердите согласие с правилами'; return; }

    var cap = captchaBody('register');
    if (!cap) { registerError.textContent = 'Введите ответ на пример'; return; }

    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    api('/api/auth/register', {
      method: 'POST',
      body: {
        name: name,
        email: email,
        password: password,
        captchaId: cap.captchaId,
        captchaAnswer: cap.captchaAnswer
      }
    })
      .then(function (data) {
        enter(data);
        toast('Аккаунт создан. Пробный период активирован.');
      })
      .catch(function (err) {
        if (err.code === 'CAPTCHA_FAILED') loadCaptcha('register');
        registerError.textContent = err.message;
      })
      .finally(function () { btn.disabled = false; });
  };

  function enter(data) {
    state.me = data;
    state.authShown = false;
    syncLocalUser(data.user.id);
    hideAuth();
    loadApp();
    renderAccountBlock();
    applyRole();
    handlePaymentReturn();
  }

  function planLabel(entitlement) {
    var plan = entitlement.plan;
    if (entitlement.source === 'trial') return 'Пробный · ' + entitlement.trial.daysLeft + ' дн.';
    if (entitlement.source === 'subscription') {
      return plan.name + ' · до ' + formatDate(entitlement.subscription.periodEnd);
    }
    return plan.name;
  }

  function renderAccountBlock() {
    if (!state.me) return;
    var user = state.me.user;
    var ent = state.me.entitlement;

    var avatar = $('accAvatar');
    if (avatar) avatar.textContent = initial(user.name);
    var name = $('accName');
    if (name) name.textContent = user.name;
    var plan = $('accPlanMini');
    if (plan) {
      plan.textContent = planLabel(ent);
      plan.classList.toggle('warn', ent.source === 'free');
    }
    var profileAvatar = $('profileAvatar');
    if (profileAvatar) profileAvatar.textContent = initial(user.name);
  }

  // Служебные кнопки видны только администратору: ручки всё равно
  // ответят 403, но зачем показывать кнопку, которая не работает.
  function applyRole() {
    var admin = !!(state.me && state.me.user && state.me.user.role === 'admin');
    var clean = $('btnCleanCache');
    if (clean) clean.hidden = !admin;
  }

  // ---------- Начальная загрузка ----------
  function boot() {
    api('/api/auth/me')
      .then(function (data) {
        state.me = data;
        state.authShown = false;
        syncLocalUser(data.user.id);
        hideAuth();
        loadApp();
        renderAccountBlock();
        applyRole();
        handlePaymentReturn();
      })
      .catch(function (err) {
        showAuth();
        loadCaptcha('register');
        if (err.status && err.status !== 401) authNotice(err.message);
      });
  }

  function authNotice(message) {
    var el = $('loginError');
    if (el) el.textContent = message;
  }

  function refreshMe() {
    return api('/api/auth/me').then(function (data) {
      state.me = data;
      renderAccountBlock();
      window.dispatchEvent(new CustomEvent('pw:me', { detail: data }));
      return data;
    });
  }

  // После оплаты провайдер возвращает на /?paid=1, заглушка — на /?invoice=…
  function handlePaymentReturn() {
    var params = new URLSearchParams(location.search);
    var paid = params.get('paid');
    var invoice = params.get('invoice');
    if (!paid && !invoice) return;

    if (paid) toast('Проверяем оплату…', 4000);

    // Вебхук провайдера может прийти на пару секунд позже возврата
    // пользователя: несколько раз перечитываем статус, прежде чем сдаться.
    var attempts = 0;
    function checkPayment() {
      refreshMe().then(function (data) {
        var active = data.entitlement.source === 'subscription';
        if (active || attempts >= 3 || invoice) {
          openSettingsWhenReady('billing');
          return;
        }
        attempts++;
        setTimeout(checkPayment, 2000);
      }).catch(function () { /* останемся на текущем экране */ });
    }
    checkPayment();

    try {
      history.replaceState({}, '', location.pathname);
    } catch (e) { /* старый браузер */ }
  }

  // settings.js подгружается скриптом: к моменту клика он обычно готов,
  // но на медленной сети — не всегда.
  function openSettingsWhenReady(tab) {
    if (window.PWSettings) {
      window.PWSettings.open(tab);
      return;
    }
    setTimeout(function () { openSettingsWhenReady(tab); }, 80);
  }

  function openSettings() {
    openSettingsWhenReady();
  }

  $('btnAccount').onclick = openSettings;
  var accountTop = $('btnAccountTop');
  if (accountTop) accountTop.onclick = openSettings;

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---------- Глобальная реакция на истёкшую сессию ----------
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return nativeFetch(input, init).then(function (res) {
      if (res.status === 401 && !state.authShown) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/auth/') === -1) {
          state.authShown = true;
          showAuth();
          authNotice('Сессия истекла. Войдите заново.');
        }
      }
      return res;
    });
  };

  window.PW = {
    api: api,
    toast: toast,
    esc: esc,
    money: money,
    formatDate: formatDate,
    initial: initial,
    state: state,
    refreshMe: refreshMe,
    openSettings: openSettings,
    clearUserData: clearUserData
  };

  boot();
})();
