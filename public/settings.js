// Настройки: профиль, безопасность, подписка и счета.
// Загружается gate.js после подтверждения сессии; использует window.PW.
(function () {
  'use strict';

  if (!window.PW) return;

  var api = PW.api;
  var esc = PW.esc;
  var money = PW.money;
  var formatDate = PW.formatDate;

  var modal = document.getElementById('settingsModal');
  var content = modal.querySelector('.settings-content');
  var nav = modal.querySelector('.settings-nav');

  var local = {
    plans: null,
    selectedPlan: 'basic',
    selectedMonths: 1,
    tab: 'profile',
    loaded: false
  };

  function $(id) { return document.getElementById(id); }

  function me() { return PW.state.me; }
  function ent() { return me() && me().entitlement; }

  // ---------- Открытие и вкладки ----------
  function open(tab) {
    if (!me()) return;
    modal.classList.add('open');
    setTab(tab || local.tab || 'profile');
    if (!local.loaded) {
      local.loaded = true;
      loadPlans();
      loadSessions();
    }
    renderAll();
    var first = nav.querySelector('.settings-tab.active');
    if (first) first.focus();
  }

  function close() {
    modal.classList.remove('open');
  }

  function setTab(tab) {
    local.tab = tab;
    Array.prototype.forEach.call(nav.querySelectorAll('.settings-tab'), function (btn) {
      var active = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    Array.prototype.forEach.call(content.querySelectorAll('.settings-panel'), function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-panel') === tab);
    });

    // Расход и подписка могли измениться, пока окно было закрыто.
    if (tab === 'billing') {
      PW.refreshMe().then(function () { renderBilling(); }).catch(function () {});
    }
  }

  // Фокус не должен уходить за пределы окна настроек: это модальное окно.
  function focusables() {
    return Array.prototype.slice.call(modal.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), textarea, select'
    )).filter(function (el) {
      return el.offsetParent !== null;
    });
  }

  function onKeydown(e) {
    if (!modal.classList.contains('open')) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;

    var items = focusables();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  document.addEventListener('keydown', onKeydown);

  nav.addEventListener('click', function (e) {
    var btn = e.target.closest('.settings-tab');
    if (!btn) return;
    setTab(btn.getAttribute('data-tab'));
  });

  modal.addEventListener('click', function (e) {
    if (e.target === modal) close();
  });
  $('settingsClose').onclick = close;

  // ---------- Данные ----------
  function loadPlans() {
    return api('/api/billing/plans').then(function (data) {
      local.plans = data;
      var label = document.getElementById('trialDaysLabel');
      if (label && typeof data.trialDays === 'number') label.textContent = data.trialDays;
      renderBilling();
    }).catch(function () { /* каталог не критичен */ });
  }

  function loadSessions() {
    return api('/api/auth/sessions').then(function (data) {
      local.sessions = data.sessions || [];
      renderSessions();
    }).catch(function (e) {
      var list = $('sessionList');
      if (list) list.innerHTML = '<div class="empty">Не удалось загрузить сессии: ' + esc(e.message) + '</div>';
    });
  }

  // ---------- Общий рендер ----------
  function renderAll() {
    renderProfile();
    renderBilling();
    renderSessions();
    $('settingsSub').textContent = me().user.email;
  }

  // ---------- Профиль ----------
  function renderProfile() {
    var data = me();
    if (!data) return;
    var user = data.user;
    var e = data.entitlement;

    $('profileAvatar').textContent = PW.initial(user.name);
    $('profileName').textContent = user.name;
    $('profileEmail').textContent = user.email;
    $('profilePlan').textContent = e.source === 'trial'
      ? 'Пробный · осталось ' + e.trial.daysLeft + ' дн.'
      : (e.source === 'subscription' ? e.plan.name + ' · до ' + formatDate(e.subscription.periodEnd) : 'Free');

    var form = $('profileForm');
    if (document.activeElement !== form.name) form.name.value = user.name;
    if (document.activeElement !== form.email) form.email.value = user.email;

    $('profileCreated').textContent = formatDate(user.createdAt);
    $('profileTariff').textContent = e.plan.name;
    $('profileLimit').textContent = data.usage.today + ' из ' + e.plan.dailyGenerations + ' генераций';
  }

  var profileForm = $('profileForm');
  profileForm.email.addEventListener('input', function () {
    var changed = profileForm.email.value.trim().toLowerCase() !== (me().user.email || '');
    $('emailPasswordRow').hidden = !changed;
  });

  profileForm.onsubmit = function (e) {
    e.preventDefault();
    var note = $('profileNote');
    note.textContent = '';
    note.className = 'form-note';

    var body = { name: profileForm.name.value.trim() };
    var email = profileForm.email.value.trim().toLowerCase();
    if (email !== me().user.email) {
      body.email = email;
      body.currentPassword = profileForm.currentPassword.value;
      if (!body.currentPassword) {
        note.textContent = 'Для смены email введите текущий пароль.';
        note.className = 'form-note error';
        return;
      }
    }

    var btn = profileForm.querySelector('button[type=submit]');
    btn.disabled = true;
    api('/api/auth/profile', { method: 'POST', body: body })
      .then(function (data) {
        PW.state.me = data;
        note.textContent = 'Профиль сохранён.';
        note.className = 'form-note ok';
        profileForm.currentPassword.value = '';
        $('emailPasswordRow').hidden = true;
        renderAll();
        PW.refreshMe().catch(function () {});
      })
      .catch(function (err) {
        note.textContent = err.message;
        note.className = 'form-note error';
      })
      .finally(function () { btn.disabled = false; });
  };

  // ---------- Безопасность ----------
  $('passwordForm').onsubmit = function (e) {
    e.preventDefault();
    var form = e.target;
    var note = $('passwordNote');
    note.textContent = '';
    note.className = 'form-note';

    if (form.newPassword.value !== form.newPassword2.value) {
      note.textContent = 'Новые пароли не совпадают.';
      note.className = 'form-note error';
      return;
    }
    if (form.newPassword.value.length < 8) {
      note.textContent = 'Пароль короче 8 символов.';
      note.className = 'form-note error';
      return;
    }

    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    api('/api/auth/password', {
      method: 'POST',
      body: { oldPassword: form.oldPassword.value, newPassword: form.newPassword.value }
    })
      .then(function (data) {
        PW.state.me = data;
        form.reset();
        note.textContent = 'Пароль изменён. Остальные сессии завершены.';
        note.className = 'form-note ok';
        loadSessions();
        renderAll();
        PW.toast('Пароль изменён');
      })
      .catch(function (err) {
        note.textContent = err.message;
        note.className = 'form-note error';
      })
      .finally(function () { btn.disabled = false; });
  };

  function deviceName(userAgent) {
    var ua = String(userAgent || '');
    var os = 'Устройство';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
    else if (/Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';

    var browser = 'браузер';
    if (/YaBrowser/i.test(ua)) browser = 'Яндекс';
    else if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';
    else if (/Chrome/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua)) browser = 'Safari';

    return os + ' · ' + browser;
  }

  function renderSessions() {
    var list = $('sessionList');
    if (!list) return;
    var sessions = local.sessions || [];
    if (!sessions.length) {
      list.innerHTML = '<div class="empty">Активных сессий нет</div>';
      return;
    }

    list.innerHTML = sessions.map(function (s) {
      return '<div class="session">' +
        '<div class="session-main">' +
        '<div class="session-device">' + esc(deviceName(s.userAgent)) +
        (s.current ? ' <span class="badge">это устройство</span>' : '') + '</div>' +
        '<div class="session-meta">Вход ' + esc(formatDate(s.createdAt)) +
        (s.ip ? ' · ' + esc(s.ip) : '') + '</div>' +
        '</div>' +
        (s.current ? '' : '<button type="button" class="ghost session-revoke" data-session="' + esc(s.id) + '">Завершить</button>') +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(list.querySelectorAll('.session-revoke'), function (btn) {
      btn.onclick = function () {
        btn.disabled = true;
        api('/api/auth/sessions/revoke', { method: 'POST', body: { id: btn.getAttribute('data-session') } })
          .then(function () { return loadSessions(); })
          .catch(function (err) { PW.toast('Не удалось: ' + err.message); btn.disabled = false; });
      };
    });
  }

  $('btnRevokeOthers').onclick = function () {
    api('/api/auth/sessions/revoke', { method: 'POST', body: { all: true } })
      .then(function (res) {
        PW.toast('Завершено сессий: ' + res.removed);
        return loadSessions();
      })
      .catch(function (err) { PW.toast(err.message, 4000); });
  };

  // ---------- Подписка ----------
  function renderBilling() {
    var data = me();
    if (!data) return;
    var e = data.entitlement;
    var usage = data.usage || { today: 0, month: 0 };

    $('billingPlanChip').textContent = e.source === 'trial'
      ? 'Пробный период · ' + e.trial.daysLeft + ' дн.'
      : e.plan.name;
    $('usageRow').innerHTML =
      '<span>Сегодня: <strong>' + usage.today + ' / ' + e.plan.dailyGenerations + '</strong></span>' +
      '<span>За месяц: <strong>' + usage.month + ' / ' + e.plan.monthlyGenerations + '</strong></span>';

    var percent = e.plan.dailyGenerations
      ? Math.min(100, Math.round(usage.today / e.plan.dailyGenerations * 100))
      : 0;
    var fill = $('usageFill');
    fill.style.width = percent + '%';
    fill.classList.toggle('hot', percent >= 80);

    var note = '';
    if (e.source === 'trial') {
      note = 'Пробный период до ' + formatDate(e.trial.endsAt) +
        '. После него останется тариф Free: ' + e.plan.dailyGenerations + ' генераций в день.';
    } else if (e.source === 'subscription') {
      note = 'Подписка ' + e.plan.name + ' активна до ' + formatDate(e.subscription.periodEnd) + '.';
      if (e.subscription.cancelAtPeriodEnd) note += ' Автопродление отключено.';
    } else {
      note = 'Бесплатный тариф: ' + e.plan.dailyGenerations + ' новых генераций в день. ' +
        'Готовые уроки из кеша открываются без ограничений.';
    }
    $('usageNote').textContent = note;

    var cancelBtn = $('btnCancelSub');
    cancelBtn.hidden = e.source !== 'subscription';
    cancelBtn.textContent = e.subscription.cancelAtPeriodEnd ? 'Возобновить продление' : 'Отменить автопродление';

    renderPlanGrid();
    renderPaymentNote();
  }

  function renderPaymentNote() {
    var data = me();
    var note = $('billingNote');
    if (!note || !data) return;
    if (data.paymentMode === 'yookassa') {
      note.textContent = 'Оплата по СБП через ЮKassa: после нажатия кнопки откроется страница выбора банка.';
    } else if (data.paymentMode === 'stub') {
      note.textContent = 'Тестовый режим: нажатие кнопки сразу подтверждает платёж, деньги не списываются.';
    } else {
      note.textContent = 'Оплата временно недоступна: провайдер не настроен.';
    }
  }

  function planById(id) {
    if (!local.plans) return null;
    for (var i = 0; i < local.plans.plans.length; i++) {
      if (local.plans.plans[i].id === id) return local.plans.plans[i];
    }
    return null;
  }

  function activePlanId() {
    var e = ent();
    return e && e.source === 'subscription' ? e.plan.id : null;
  }

  function planAction(planId) {
    var active = activePlanId();
    if (!active) return 'new';
    var from = planById(active);
    var to = planById(planId);
    if (!from || !to) return 'new';
    if (to.rank < from.rank) return 'blocked';
    return to.rank === from.rank ? 'renew' : 'upgrade';
  }

  function renderPlanGrid() {
    var grid = $('planGrid');
    if (!grid || !local.plans) return;

    var current = activePlanId();
    var currentPlan = current ? planById(current) : null;
    var cards = local.plans.plans.filter(function (p) { return p.purchasable; });

    // С активной подпиской понижение не предлагаем: оплаченные дни
    // пропали бы. Видны текущий тариф и выше.
    if (currentPlan) {
      cards = cards.filter(function (p) { return p.rank >= currentPlan.rank; });
      if (planAction(local.selectedPlan) === 'blocked' || !planById(local.selectedPlan)) {
        local.selectedPlan = current;
      }
    } else if (!planById(local.selectedPlan)) {
      local.selectedPlan = 'basic';
    }

    grid.innerHTML = cards.map(function (plan) {
      var active = current === plan.id ? ' active' : '';
      var chosen = local.selectedPlan === plan.id ? ' chosen' : '';
      var hint = '';
      if (active && currentPlan && plan.rank > currentPlan.rank) {
        hint = '<div class="plan-desc">повышение — остаток периода сохранится</div>';
      }
      return '<button type="button" class="plan-card' + active + chosen + '" data-plan="' + esc(plan.id) + '">' +
        '<div class="plan-name">' + esc(plan.name) + '</div>' +
        '<div class="plan-price">' + esc(money(plan.priceMonthly, 'RUB')) + '<span>/мес</span></div>' +
        '<div class="plan-desc">' + Number(plan.dailyGenerations) + ' генераций в день</div>' +
        hint +
        (active ? '<div class="plan-current">текущий тариф</div>' : '') +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(grid.querySelectorAll('.plan-card'), function (btn) {
      btn.onclick = function () {
        local.selectedPlan = btn.getAttribute('data-plan');
        renderPlanGrid();
        renderPeriods();
      };
    });

    renderPeriods();
  }

  function renderPeriods() {
    var row = $('periodRow');
    if (!row || !local.plans) return;
    var plan = planById(local.selectedPlan);

    row.innerHTML = '<span class="period-label">Период:</span>' + local.plans.periods.map(function (p) {
      var chosen = local.selectedMonths === p.months ? ' chosen' : '';
      var amount = plan ? Math.round(plan.priceMonthly * p.months * (1 - p.discount)) : 0;
      return '<button type="button" class="period-btn' + chosen + '" data-months="' + p.months + '">' +
        p.months + ' мес' + (p.discount ? ' · −' + Math.round(p.discount * 100) + '%' : '') +
        (plan ? '<span>' + esc(money(amount, 'RUB')) + '</span>' : '') +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(row.querySelectorAll('.period-btn'), function (btn) {
      btn.onclick = function () {
        local.selectedMonths = Number(btn.getAttribute('data-months'));
        renderPeriods();
      };
    });

    var checkout = $('btnCheckout');
    var providerOff = me() && me().paymentMode === 'none';
    var action = planAction(local.selectedPlan);
    var name = plan ? plan.name : local.selectedPlan;
    var label = action === 'renew'
      ? 'Продлить ' + name
      : (action === 'upgrade' ? 'Перейти на ' + name : 'Оформить ' + name);

    checkout.disabled = !local.selectedPlan || providerOff;
    checkout.textContent = providerOff ? 'Оплата недоступна' : label;
  }

  $('btnCheckout').onclick = function () {
    var btn = $('btnCheckout');
    btn.disabled = true;

    api('/api/billing/checkout', {
      method: 'POST',
      body: { planId: local.selectedPlan, months: local.selectedMonths }
    }).then(function (data) {
      var payment = data.payment || {};

      // ЮKassa: уводим на страницу выбора банка, вернёмся по return_url.
      if (payment.confirmationUrl && payment.provider !== 'stub') {
        window.location.href = payment.confirmationUrl;
        return null;
      }

      // Заглушка: сразу подтверждаем, как будто пользователь оплатил
      // на сайте банка и вернулся.
      PW.toast('Переходим к оплате…', 1500);
      return api('/api/billing/invoices/' + encodeURIComponent(data.invoice.id) + '/pay', {
        method: 'POST', body: {}
      }).then(function () {
        return PW.refreshMe().then(function () {
          var kind = data.invoice.kind;
          PW.toast(kind === 'renew'
            ? 'Подписка продлена'
            : (kind === 'upgrade' ? 'Тариф повышен, остаток периода сохранён' : 'Подписка активирована'));
          renderAll();
        });
      });
    }).catch(function (err) {
      if (err.code === 'DOWNGRADE_NOT_ALLOWED') {
        PW.toast('Понизить тариф можно после окончания оплаченного периода', 5000);
      } else {
        PW.toast('Не удалось оплатить: ' + err.message, 5000);
      }
    }).finally(function () {
      btn.disabled = false;
      renderPeriods();
    });
  };

  $('btnCancelSub').onclick = function () {
    var resume = me().entitlement.subscription.cancelAtPeriodEnd;
    api('/api/billing/cancel', { method: 'POST', body: { resume: !!resume } })
      .then(function () {
        PW.toast(resume ? 'Автопродление включено' : 'Автопродление отключено');
        return PW.refreshMe();
      })
      .then(function () { renderBilling(); })
      .catch(function (err) { PW.toast(err.message, 4000); });
  };

  // ---------- Выход ----------
  $('btnLogout').onclick = function () {
    api('/api/auth/logout', { method: 'POST', body: {} })
      .catch(function () {})
      .finally(function () {
        PW.clearUserData();
        location.href = '/';
      });
  };

  // gate.js присылает обновление после /api/auth/me.
  window.addEventListener('pw:me', function () {
    if (!modal.classList.contains('open')) return;
    renderAll();
  });

  window.PWSettings = { open: open, close: close };
})();
