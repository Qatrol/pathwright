// Вход и личный кабинет. Загружается до app.js: основное приложение
// стартует только после подтверждённой сессии.
(function () {
  'use strict';

  var THEME_KEY = 'devops_tutor_theme';
  var state = {
    me: null,
    plans: null,
    invoices: [],
    selectedPlan: 'basic',
    selectedMonths: 1,
    booted: false,
    stub: true,
    authShown: false
  };

  // Локальные данные приложения (прогресс, кэш уроков, id сессии) не должны
  // переезжать между аккаунтами одного браузера. Тема остаётся общей.
  var USER_DATA_PREFIXES = [
    'devops_tutor_session_id',
    'devops_tutor_progress',
    'devops_tutor_cache_',
    'devops_tutor_collapsed'
  ];
  var USER_ID_KEY = 'pathwright_user_id';

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

  // При смене аккаунта чистим чужие локальные данные; при первом входе
  // просто запоминаем, чей это браузер.
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
      // stored === null — первый вход после обновления версии; в браузере
      // могли остаться данные предыдущего аккаунта.
      if (forceClear || (stored && stored !== userId) || (!stored && hasUserData())) {
        clearUserData();
      }
      localStorage.setItem(USER_ID_KEY, userId);
    } catch (e) { /* приватный режим */ }
  }

  var $ = function (id) { return document.getElementById(id); };
  var authScreen = $('authScreen');
  var authError = $('loginError');
  var regError = $('registerError');
  var accountModal = $('accountModal');
  var planChip = $('planChip');

  // Тема применяется до загрузки app.js, иначе будет вспышка светлого фона.
  try {
    var savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  } catch (e) { /* приватный режим */ }

  // ---------- API ----------
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

  function money(amount, currency) {
    return Number(amount).toLocaleString('ru-RU') + ' ' + (currency === 'RUB' ? '₽' : currency);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('ru-RU');
  }

  function planLabel(entitlement) {
    var plan = entitlement.plan;
    if (entitlement.source === 'trial') {
      return 'Пробный · ' + entitlement.trial.daysLeft + ' дн.';
    }
    if (entitlement.source === 'subscription') {
      return plan.name + ' · до ' + formatDate(entitlement.subscription.periodEnd);
    }
    return plan.name;
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

  function loadApp() {
    if (state.booted) return;
    state.booted = true;
    var s = document.createElement('script');
    s.src = '/app.js';
    s.defer = true;
    s.setAttribute('data-pw-app', '1');
    document.body.appendChild(s);
  }

  function switchTab(register) {
    $('tabLogin').classList.toggle('active', !register);
    $('tabRegister').classList.toggle('active', register);
    $('tabLogin').setAttribute('aria-selected', String(!register));
    $('tabRegister').setAttribute('aria-selected', String(register));
    $('loginForm').hidden = register;
    $('registerForm').hidden = !register;
    authError.textContent = '';
    regError.textContent = '';
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
    authError.textContent = '';
    if (!email || !password) { authError.textContent = 'Заполните email и пароль'; return; }

    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    api('/api/auth/login', { method: 'POST', body: { email: email, password: password } })
      .then(function (data) { enter(data); })
      .catch(function (err) {
        authError.textContent = err.message;
        // 429 подсказывает подождать, остальное — просто ошибка.
        if (err.status === 429) authError.textContent = err.message;
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
    regError.textContent = '';

    if (!name) { regError.textContent = 'Введите имя'; return; }
    if (password.length < 8) { regError.textContent = 'Пароль короче 8 символов'; return; }
    if (password !== password2) { regError.textContent = 'Пароли не совпадают'; return; }

    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    api('/api/auth/register', {
      method: 'POST',
      body: { name: name, email: email, password: password }
    })
      .then(function (data) {
        enter(data);
        toast('Аккаунт создан. Пробный период активирован.');
      })
      .catch(function (err) { regError.textContent = err.message; })
      .finally(function () { btn.disabled = false; });
  };

  function enter(data) {
    state.me = data;
    state.authShown = false;
    state.stub = data.paymentStub !== false;
    syncLocalUser(data.user.id);
    hideAuth();
    loadApp();
    renderChips();
    applyRole();
    if (new URLSearchParams(location.search).get('invoice')) openAccount();
  }

  // ---------- Начальная загрузка ----------
  function boot() {
    api('/api/auth/me')
      .then(function (data) {
        state.me = data;
        state.authShown = false;
        state.stub = data.paymentStub !== false;
        syncLocalUser(data.user.id);
        hideAuth();
        loadApp();
        renderChips();
        applyRole();
      })
      .catch(function (err) {
        // 401 — обычная ситуация до входа; сеть/500 — тоже показываем форму.
        showAuth();
        if (err.status && err.status !== 401) {
          authError.textContent = err.message;
        }
      })
      .finally(function () {
        loadPlans();
      });
  }

  function loadPlans() {
    api('/api/billing/plans').then(function (data) {
      state.plans = data;
      var label = $('trialDaysLabel');
      if (label && typeof data.trialDays === 'number') label.textContent = data.trialDays;
      renderPlanGrid();
    }).catch(function () { /* каталог не критичен для входа */ });
  }

  function refreshMe() {
    return api('/api/auth/me').then(function (data) {
      state.me = data;
      renderChips();
      if (accountModal.classList.contains('open')) renderAccount();
      return data;
    });
  }

  // Служебные кнопки видны только администратору: ручки всё равно
  // ответят 403, но зачем показывать кнопку, которая не работает.
  function applyRole() {
    var admin = !!(state.me && state.me.user && state.me.user.role === 'admin');
    var clean = $('btnCleanCache');
    if (clean) clean.hidden = !admin;
  }

  function renderChips() {
    if (!state.me || !planChip) return;
    var entitlement = state.me.entitlement;
    planChip.textContent = planLabel(entitlement);
    planChip.classList.toggle('warn', entitlement.source === 'free');
    if (entitlement.source === 'free' && entitlement.plan.id === 'free' && state.me.usage) {
      planChip.textContent = 'Free · ' + state.me.usage.today + '/' + entitlement.plan.dailyGenerations;
    }
  }

  // ---------- Личный кабинет ----------
  function openAccount() {
    if (!state.me) return;
    accountModal.classList.add('open');
    renderAccount();
    api('/api/billing/invoices')
      .then(function (data) { state.invoices = data.invoices || []; renderInvoices(); })
      .catch(function (e) { toast('Счета не загрузились: ' + e.message); });
  }

  function closeAccount() {
    accountModal.classList.remove('open');
  }

  $('accountClose').onclick = closeAccount;
  accountModal.addEventListener('click', function (e) {
    if (e.target === accountModal) closeAccount();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && accountModal.classList.contains('open')) closeAccount();
  });

  function renderAccount() {
    var me = state.me;
    if (!me) return;
    var ent = me.entitlement;
    var usage = me.usage || { today: 0, month: 0 };

    $('accountWho').textContent = me.user.name + ' · ' + me.user.email;
    $('accPlanChip').textContent = planLabel(ent);

    $('usageRow').innerHTML =
      '<span>Сегодня: <strong>' + usage.today + ' / ' + ent.plan.dailyGenerations + '</strong></span>' +
      '<span>За месяц: <strong>' + usage.month + ' / ' + ent.plan.monthlyGenerations + '</strong></span>';

    var percent = ent.plan.dailyGenerations
      ? Math.min(100, Math.round(usage.today / ent.plan.dailyGenerations * 100))
      : 0;
    var fill = $('usageFill');
    fill.style.width = percent + '%';
    fill.classList.toggle('hot', percent >= 80);

    var note = '';
    if (ent.source === 'trial') {
      note = 'Пробный период до ' + formatDate(ent.trial.endsAt) +
        '. После него останется тариф Free: ' + ent.plan.dailyGenerations + ' генераций в день.';
    } else if (ent.source === 'subscription') {
      note = 'Подписка ' + ent.plan.name + ' активна до ' + formatDate(ent.subscription.periodEnd) + '.';
      if (ent.subscription.cancelAtPeriodEnd) note += ' Автопродление отключено.';
    } else {
      note = 'Бесплатный тариф: ' + ent.plan.dailyGenerations + ' новых генераций в день. ' +
        'Готовые уроки из кеша открываются без ограничений.';
    }
    $('usageNote').textContent = note;

    var cancelBtn = $('btnCancelSub');
    cancelBtn.hidden = ent.source !== 'subscription';
    cancelBtn.textContent = ent.subscription.cancelAtPeriodEnd ? 'Возобновить продление' : 'Отменить автопродление';

    renderPlanGrid();
  }

  function renderPlanGrid() {
    var grid = $('planGrid');
    if (!grid || !state.plans) return;
    var current = state.me ? state.me.entitlement.plan.id : null;
    var cards = state.plans.plans.filter(function (p) { return p.purchasable; });

    grid.innerHTML = cards.map(function (plan) {
      var active = current === plan.id ? ' active' : '';
      var chosen = state.selectedPlan === plan.id ? ' chosen' : '';
      return '<button type="button" class="plan-card' + active + chosen + '" data-plan="' + esc(plan.id) + '">' +
        '<div class="plan-name">' + esc(plan.name) + '</div>' +
        '<div class="plan-price">' + esc(money(plan.priceMonthly, 'RUB')) + '<span>/мес</span></div>' +
        '<div class="plan-desc">' + Number(plan.dailyGenerations) + ' генераций в день</div>' +
        (active ? '<div class="plan-current">текущий тариф</div>' : '') +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(grid.querySelectorAll('.plan-card'), function (btn) {
      btn.onclick = function () {
        state.selectedPlan = btn.getAttribute('data-plan');
        renderPlanGrid();
        renderPeriods();
      };
    });

    renderPeriods();
  }

  function renderPeriods() {
    var row = $('periodRow');
    if (!row || !state.plans) return;
    var plan = Object.prototype.hasOwnProperty.call(planPriceMap(), state.selectedPlan)
      ? planPriceMap()[state.selectedPlan] : null;

    row.innerHTML = '<span class="period-label">Период:</span>' + state.plans.periods.map(function (p) {
      var chosen = state.selectedMonths === p.months ? ' chosen' : '';
      var amount = plan ? Math.round(plan.priceMonthly * p.months * (1 - p.discount)) : 0;
      return '<button type="button" class="period-btn' + chosen + '" data-months="' + p.months + '">' +
        p.months + ' мес' + (p.discount ? ' · −' + Math.round(p.discount * 100) + '%' : '') +
        (plan ? '<span>' + money(amount, 'RUB') + '</span>' : '') +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(row.querySelectorAll('.period-btn'), function (btn) {
      btn.onclick = function () {
        state.selectedMonths = Number(btn.getAttribute('data-months'));
        renderPeriods();
      };
    });

    var checkout = $('btnCheckout');
    checkout.disabled = !state.selectedPlan;
    checkout.textContent = 'Оформить ' + state.selectedPlan;
    $('billingNote').textContent = state.stub
      ? 'Оплата работает в тестовом режиме: счёт создаётся, оплата подтверждается кнопкой. Деньги не списываются.'
      : '';
  }

  function planPriceMap() {
    var map = {};
    if (!state.plans) return map;
    state.plans.plans.forEach(function (p) { map[p.id] = p; });
    return map;
  }

  $('btnCheckout').onclick = function () {
    var btn = $('btnCheckout');
    btn.disabled = true;
    api('/api/billing/checkout', {
      method: 'POST',
      body: { planId: state.selectedPlan, months: state.selectedMonths }
    }).then(function (data) {
      toast('Счёт создан: ' + money(data.invoice.amount, data.invoice.currency));
      return api('/api/billing/invoices').then(function (list) {
        state.invoices = list.invoices || [];
        renderInvoices();
      });
    }).catch(function (err) {
      toast('Не удалось создать счёт: ' + err.message, 5000);
    }).finally(function () {
      renderPeriods();
    });
  };

  function renderInvoices() {
    var list = $('invoiceList');
    if (!list) return;
    if (!state.invoices.length) {
      list.innerHTML = '<div class="empty">Счетов пока нет</div>';
      return;
    }

    list.innerHTML = state.invoices.map(function (inv) {
      var statusText = {
        pending: 'ожидает оплаты',
        paid: 'оплачен',
        cancelled: 'отменён',
        expired: 'истёк'
      }[inv.status] || inv.status;

      var action = '';
      if (inv.status === 'pending') {
        action = '<button type="button" class="ghost pay" data-invoice="' + esc(inv.id) + '">Оплатить (тест)</button>';
      }

      return '<div class="invoice">' +
        '<div class="invoice-main">' +
        '<div class="invoice-title">' + esc(inv.planName) + ' · ' + Number(inv.months) + ' мес</div>' +
        '<div class="invoice-meta">' + esc(formatDate(inv.createdAt)) + ' · ' + esc(statusText) + '</div>' +
        '</div>' +
        '<div class="invoice-amount">' + esc(money(inv.amount, inv.currency)) + '</div>' +
        action +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(list.querySelectorAll('.pay'), function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute('data-invoice');
        btn.disabled = true;
        api('/api/billing/invoices/' + encodeURIComponent(id) + '/pay', { method: 'POST', body: {} })
          .then(function () {
            toast('Оплата подтверждена (тестовый режим). Подписка активирована.');
            return Promise.all([refreshMe(), api('/api/billing/invoices')]);
          })
          .then(function (results) {
            state.invoices = results[1].invoices || [];
            renderInvoices();
          })
          .catch(function (err) {
            toast('Оплата не прошла: ' + err.message, 5000);
            btn.disabled = false;
          });
      };
    });
  }

  $('btnCancelSub').onclick = function () {
    var resume = state.me && state.me.entitlement.subscription.cancelAtPeriodEnd;
    api('/api/billing/cancel', { method: 'POST', body: { resume: !!resume } })
      .then(function () {
        toast(resume ? 'Автопродление включено' : 'Автопродление отключено');
        return refreshMe();
      })
      .catch(function (err) { toast(err.message, 4000); });
  };

  $('passwordForm').onsubmit = function (e) {
    e.preventDefault();
    var form = e.target;
    var note = $('passwordNote');
    note.textContent = '';
    api('/api/auth/password', {
      method: 'POST',
      body: { oldPassword: form.oldPassword.value, newPassword: form.newPassword.value }
    }).then(function (data) {
      state.me = data;
      form.reset();
      note.textContent = 'Пароль изменён. Остальные сессии завершены.';
      renderChips();
      renderAccount();
      toast('Пароль изменён');
    }).catch(function (err) {
      note.textContent = err.message;
    });
  };

  $('btnLogout').onclick = function () {
    api('/api/auth/logout', { method: 'POST', body: {} })
      .catch(function () {})
      .finally(function () {
        clearUserData();
        location.href = '/';
      });
  };

  $('btnAccount').onclick = openAccount;

  // ---------- Глобальная реакция на истёкшую сессию ----------
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return nativeFetch(input, init).then(function (res) {
      if (res.status === 401 && !state.authShown) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/auth/') === -1) {
          state.authShown = true;
          showAuth();
          authError.textContent = 'Сессия истекла. Войдите заново.';
        }
      }
      return res;
    });
  };

  boot();
})();
