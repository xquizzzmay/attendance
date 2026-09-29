/* Посещаемость — сайт для старост. Все права проверяет сервер (worker/), здесь только экран. */
(function () {
  'use strict';

  var API = String(window.API_URL || '').replace(/\/+$/, '');
  var TZ_MS = 5 * 3600 * 1000; // Ташкент
  var WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  var WD_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  var st = {
    token: null, role: null, skew: 0, lockTime: '15:10',
    groupId: null, group: null,          // группа, которую сейчас смотрим
    students: [], day: null, pair: 1, marks: {}, editable: false, why: null,
    monday: null, report: null, tab: 'mark'
  };

  /* ---------- Мелочи ---------- */

  function $(id) { return document.getElementById(id); }
  // Создание элементов без innerHTML — имена учеников выводятся только как текст.
  function h(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== false && props[k] != null) e.setAttribute(k, props[k] === true ? '' : props[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  var toastTimer = null;
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, bad ? 5000 : 2200);
  }

  /* ---------- Даты (всё по Ташкенту) ---------- */

  function today() { return new Date(Date.now() + st.skew + TZ_MS).toISOString().slice(0, 10); }
  function wd(day) { return new Date(day + 'T00:00:00Z').getUTCDay(); }
  function addDays(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function isSchool(day) { var w = wd(day); return w >= 1 && w <= 5; }
  function mondayOf(day) { var w = wd(day); return addDays(day, w === 0 ? -6 : 1 - w); }
  function lastSchoolDay(day) { while (!isSchool(day)) day = addDays(day, -1); return day; }
  function stepSchoolDay(day, dir) { do { day = addDays(day, dir); } while (!isSchool(day)); return day; }
  function dayLong(day) { var d = new Date(day + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function dayShort(day) { return day.slice(8, 10) + '.' + day.slice(5, 7); }
  function lockText(monday) { return 'пятница, ' + dayLong(addDays(monday, 4)) + ', ' + st.lockTime; }

  /* ---------- Сервер ---------- */

  function api(method, path, body) {
    // Главный админ работает с выбранной группой — сервер узнаёт её по параметру g.
    if (st.role === 'admin' && st.groupId && /^\/api\/(students|marks|group|report)/.test(path)) {
      path += (path.indexOf('?') === -1 ? '?' : '&') + 'g=' + st.groupId;
    }
    var headers = {};
    if (st.token) headers.Authorization = 'Bearer ' + st.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })
      .catch(function () { throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'); })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.ok) return d;
          if (r.status === 401 && st.token) { dropSession(); showLogin(d.error); }
          var e = new Error(d.error || ('Ошибка сервера (' + r.status + ').'));
          e.status = r.status;
          throw e;
        });
      });
  }

  function saveSession(token) { st.token = token; lsSet('att_token', token); }
  function dropSession() { st.token = null; st.role = null; st.groupId = null; st.group = null; lsSet('att_token', null); }

  function loadMe() {
    return api('GET', '/api/me').then(function (me) {
      st.skew = me.now - Date.now();
      st.role = me.role;
      st.lockTime = me.lockTime;
      if (me.role === 'admin') showAdmin();
      else { st.groupId = me.group.id; openGroup(me.group); }
    });
  }

  function screen(id) {
    ['loginScreen', 'adminScreen', 'groupScreen'].forEach(function (s) { show(s, s === id); });
    window.scrollTo(0, 0);
  }

  /* ---------- Вход ---------- */

  function showLogin(msg) {
    screen('loginScreen');
    if (msg) $('loginError').textContent = msg;
    var sel = $('loginGroup');
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '', text: 'загружаю…' }));
    api('GET', '/api/groups').then(function (d) {
      sel.innerHTML = '';
      if (!d.groups.length) sel.appendChild(h('option', { value: '', text: 'пока нет групп — сначала регистрация по ключу' }));
      else sel.appendChild(h('option', { value: '', text: '— выберите группу —' }));
      d.groups.forEach(function (g) { sel.appendChild(h('option', { value: g.id, text: g.name })); });
      var last = lsGet('att_last_group');
      if (last && d.groups.some(function (g) { return String(g.id) === last; })) sel.value = last;
    }).catch(function (e) { sel.innerHTML = ''; sel.appendChild(h('option', { value: '', text: 'не удалось загрузить' })); $('loginError').textContent = e.message; });
  }

  function busy(form, on) {
    Array.prototype.forEach.call(form.querySelectorAll('button, input, select'), function (x) { x.disabled = on; });
  }

  function onLogin(e) {
    e.preventDefault();
    var f = e.target, err = $('loginError'), gid = $('loginGroup').value;
    err.textContent = '';
    if (!gid) { err.textContent = 'Выберите группу.'; return; }
    busy(f, true);
    api('POST', '/api/login', { groupId: Number(gid), password: $('loginPass').value }).then(function (d) {
      lsSet('att_last_group', gid);
      $('loginPass').value = '';
      saveSession(d.token);
      return loadMe();
    }).catch(function (x) { err.textContent = x.message; }).then(function () { busy(f, false); });
  }

  function onRegister(e) {
    e.preventDefault();
    var f = e.target, err = $('regError'), p = $('regPass').value;
    err.textContent = '';
    if (p.length < 8) { err.textContent = 'Пароль — не короче 8 символов.'; return; }
    if (p !== $('regPass2').value) { err.textContent = 'Пароли не совпадают.'; return; }
    busy(f, true);
    api('POST', '/api/register', { key: $('regKey').value, password: p }).then(function (d) {
      lsSet('att_last_group', String(d.group.id));
      f.reset();
      saveSession(d.token);
      toast('Готово! Запомните пароль — дальше входите по нему.');
      return loadMe();
    }).catch(function (x) { err.textContent = x.message; }).then(function () { busy(f, false); });
  }

  function onAdminLogin(e) {
    e.preventDefault();
    var f = e.target, err = $('adminError');
    err.textContent = '';
    busy(f, true);
    api('POST', '/api/admin/login', { password: $('adminPass').value }).then(function (d) {
      $('adminPass').value = '';
      saveSession(d.token);
      return loadMe();
    }).catch(function (x) { err.textContent = x.message; }).then(function () { busy(f, false); });
  }

  function logout() {
    if (st.token) api('POST', '/api/logout').catch(function () {});
    dropSession();
    showLogin();
  }

  /* ---------- Главный админ ---------- */

  function showAdmin() {
    st.groupId = null; st.group = null;
    screen('adminScreen');
    loadGroups();
  }

  function loadGroups() {
    var list = $('groupList');
    return api('GET', '/api/admin/groups').then(function (d) {
      list.innerHTML = '';
      if (!d.groups.length) { list.appendChild(h('p', { class: 'empty', text: 'Групп пока нет. Создайте первую.' })); return; }
      d.groups.forEach(function (g) {
        var status = g.registered ? 'староста зарегистрирован' : (g.keyPending ? 'ждём регистрацию по ключу' : 'нет ключа');
        list.appendChild(h('div', { class: 'item stack' }, [
          h('span', { class: 'name' }, [g.name, h('span', { class: 'sub', text: status + ' · учеников: ' + g.students + ' · пар в день: ' + g.pairsPerDay })]),
          h('span', { class: 'actions' }, [
            h('button', { class: 'btn small', type: 'button', text: 'Открыть', onclick: function () { st.groupId = g.id; openGroup(g); } }),
            h('button', { class: 'btn small ghost', type: 'button', text: 'Новый ключ', onclick: function () { resetKey(g); } }),
            h('button', { class: 'btn small danger', type: 'button', text: 'Удалить', onclick: function () { deleteGroup(g); } })
          ])
        ]));
      });
    }).catch(function (e) { $('groupError').textContent = e.message; });
  }

  function showKey(name, key) {
    $('keyGroup').textContent = name;
    $('keyValue').textContent = key;
    show('keyBox', true);
    $('keyBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function onNewGroup(e) {
    e.preventDefault();
    var f = e.target, err = $('groupError');
    err.textContent = '';
    busy(f, true);
    api('POST', '/api/admin/groups', { name: $('newGroupName').value }).then(function (d) {
      f.reset();
      showKey(d.group.name, d.key);
      return loadGroups();
    }).catch(function (x) { err.textContent = x.message; }).then(function () { busy(f, false); });
  }

  function resetKey(g) {
    if (!confirm('Выдать новый ключ для «' + g.name + '»?\n\nСтарый пароль старосты перестанет работать, ему нужно будет зарегистрироваться заново. Ученики и отметки останутся.')) return;
    api('POST', '/api/admin/groups/' + g.id + '/reset').then(function (d) { showKey(g.name, d.key); return loadGroups(); })
      .catch(function (e) { toast(e.message, true); });
  }

  function deleteGroup(g) {
    var typed = prompt('Удалить группу «' + g.name + '» вместе со всеми учениками и отметками? Это нельзя отменить.\n\nДля подтверждения впишите название группы:');
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== g.name.toLowerCase()) { toast('Название не совпало — группа не удалена.', true); return; }
    api('DELETE', '/api/admin/groups/' + g.id).then(function () { show('keyBox', false); toast('Группа удалена.'); return loadGroups(); })
      .catch(function (e) { toast(e.message, true); });
  }

  /* ---------- Группа ---------- */

  function openGroup(g) {
    st.group = { id: g.id, name: g.name, pairsPerDay: g.pairsPerDay || 3 };
    st.day = lastSchoolDay(today());
    st.pair = 1;
    st.monday = mondayOf(today());
    $('groupTitle').textContent = g.name;
    show('toGroups', st.role === 'admin');
    screen('groupScreen');
    setTab('mark');
    loadStudents().then(loadDay);
  }

  function setTab(tab) {
    st.tab = tab;
    Array.prototype.forEach.call($('groupTabs').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    ['mark', 'students', 'report'].forEach(function (t) { show('tab-' + t, t === tab); });
    if (tab === 'report') loadReport();
    if (tab === 'students') renderStudents();
  }

  function loadStudents() {
    return api('GET', '/api/students').then(function (d) {
      st.students = d.students;
      st.group.pairsPerDay = d.group.pairsPerDay;
      renderStudents();
    }).catch(function (e) { toast(e.message, true); });
  }

  /* --- Отметки --- */

  var loadSeq = 0;
  function loadDay() {
    var seq = ++loadSeq, day = st.day;
    renderMarks();
    return api('GET', '/api/marks?day=' + day).then(function (d) {
      if (seq !== loadSeq) return; // пока грузили, выбрали другой день
      st.marks = d.marks; st.editable = d.editable; st.why = d.why;
      st.group.pairsPerDay = d.pairsPerDay;
      if (st.pair > d.pairsPerDay) st.pair = 1;
      renderMarks();
    }).catch(function (e) { if (seq === loadSeq) toast(e.message, true); });
  }

  function markOf(sid, pair) { var m = st.marks[sid]; return m && m[pair] !== undefined ? m[pair] : null; }

  function renderMarks() {
    var day = st.day, t = today();
    $('dayLabel').innerHTML = '';
    $('dayLabel').appendChild(document.createTextNode(dayLong(day)));
    $('dayLabel').appendChild(h('span', { class: 'sub', text: WEEKDAYS[wd(day)] + (day === t ? ' · сегодня' : '') }));
    $('dayNext').disabled = stepSchoolDay(day, 1) > t;

    var pairs = $('pairList');
    pairs.innerHTML = '';
    for (var p = 1; p <= st.group.pairsPerDay; p++) {
      var done = st.students.filter(function (s) { return markOf(s.id, p) !== null; }).length;
      pairs.appendChild(h('button', { type: 'button', class: p === st.pair ? 'on' : '', 'data-pair': p }, [
        p + ' пара',
        h('span', { class: 'dot', text: !st.students.length ? '' : done === st.students.length ? '✓ отмечена' : done ? done + ' из ' + st.students.length : 'не отмечена' })
      ]));
    }

    var locked = !st.editable;
    show('markLocked', locked && !!st.why);
    $('markLocked').textContent = st.why || '';

    var list = $('markList');
    list.innerHTML = '';
    if (!st.students.length) {
      list.appendChild(h('p', { class: 'empty', text: 'В группе пока нет учеников. Добавьте их на вкладке «Ученики».' }));
    }
    var plus = 0, minus = 0;
    st.students.forEach(function (s) {
      var v = markOf(s.id, st.pair);
      if (v === 1) plus++; else if (v === 0) minus++;
      list.appendChild(h('div', { class: 'item' + (v === 1 ? ' is-plus' : v === 0 ? ' is-minus' : '') }, [
        h('span', { class: 'name', text: s.name }),
        h('span', { class: 'pm' }, [
          h('button', { type: 'button', class: 'p' + (v === 1 ? ' on' : ''), disabled: locked, 'aria-label': 'Пришёл', text: '+',
            onclick: function () { setMark([s.id], v === 1 ? null : 1); } }),
          h('button', { type: 'button', class: 'm' + (v === 0 ? ' on' : ''), disabled: locked, 'aria-label': 'Не пришёл', text: '−',
            onclick: function () { setMark([s.id], v === 0 ? null : 0); } })
        ])
      ]));
    });
    var none = st.students.length - plus - minus;
    $('markCount').textContent = st.students.length ? '+ ' + plus + ' · − ' + minus + (none ? ' · не отмечено ' + none : '') : '';
    var allBtn = $('allPlus');
    allBtn.textContent = plus + minus ? 'Остальным +' : 'Все +';
    allBtn.disabled = locked || !none;
  }

  // Сохраняем по очереди, чтобы быстрые нажатия не обгоняли друг друга.
  var saveChain = Promise.resolve();
  function setMark(ids, v) {
    var day = st.day, pair = st.pair;
    ids.forEach(function (id) {
      st.marks[id] = st.marks[id] || {};
      if (v === null) delete st.marks[id][pair]; else st.marks[id][pair] = v;
    });
    renderMarks();
    $('saveState').textContent = 'сохраняю…';
    saveChain = saveChain.then(function () {
      return api('PUT', '/api/marks', { day: day, pair: pair, marks: ids.map(function (id) { return { id: id, v: v }; }) });
    }).then(function () {
      $('saveState').textContent = 'сохранено ✓';
    }).catch(function (e) {
      $('saveState').textContent = '';
      toast('Не сохранилось: ' + e.message, true);
      if (st.day === day) loadDay(); // вернуть то, что реально на сервере
    });
  }

  function allPlus() {
    var ids = st.students.filter(function (s) { return markOf(s.id, st.pair) === null; }).map(function (s) { return s.id; });
    if (ids.length) setMark(ids, 1);
  }

  function goDay(dir) {
    var next = stepSchoolDay(st.day, dir);
    if (next > today()) return;
    st.day = next; st.marks = {}; st.editable = false; st.why = null;
    $('saveState').textContent = '';
    loadDay();
  }

  /* --- Ученики --- */

  function renderStudents() {
    var list = $('studentList');
    list.innerHTML = '';
    if (!st.students.length) list.appendChild(h('p', { class: 'empty', text: 'Список пуст. Добавьте учеников по одному.' }));
    st.students.forEach(function (s, i) {
      list.appendChild(h('div', { class: 'item' }, [
        h('span', { class: 'name', text: (i + 1) + '. ' + s.name }),
        h('button', { class: 'btn small danger', type: 'button', text: 'Удалить', onclick: function () { removeStudent(s); } })
      ]));
    });
    var sel = $('pairsPerDay');
    if (!sel.options.length) for (var p = 1; p <= 8; p++) sel.appendChild(h('option', { value: p, text: String(p) }));
    sel.value = String(st.group.pairsPerDay);
  }

  function onAddStudent(e) {
    e.preventDefault();
    var f = e.target, err = $('studentError');
    err.textContent = '';
    busy(f, true);
    api('POST', '/api/students', { name: $('studentName').value }).then(function (d) {
      $('studentName').value = '';
      st.students.push(d.student);
      st.students.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
      renderStudents(); renderMarks();
    }).catch(function (x) { err.textContent = x.message; }).then(function () { busy(f, false); $('studentName').focus(); });
  }

  function removeStudent(s) {
    if (!confirm('Удалить «' + s.name + '» из списка группы?\n\nЕго прошлые отметки останутся в итогах недель.')) return;
    api('DELETE', '/api/students/' + s.id).then(function () {
      st.students = st.students.filter(function (x) { return x.id !== s.id; });
      renderStudents(); renderMarks();
      toast('Удалён: ' + s.name);
    }).catch(function (e) { toast(e.message, true); });
  }

  function onPairsChange() {
    var n = Number($('pairsPerDay').value);
    api('PATCH', '/api/group', { pairsPerDay: n }).then(function (d) {
      st.group.pairsPerDay = d.pairsPerDay;
      if (st.pair > d.pairsPerDay) st.pair = 1;
      renderMarks();
      toast('Пар в день: ' + d.pairsPerDay);
    }).catch(function (e) { toast(e.message, true); renderStudents(); });
  }

  /* --- Итог недели --- */

  var reportSeq = 0;
  function loadReport() {
    var seq = ++reportSeq, monday = st.monday;
    $('weekLabel').innerHTML = '';
    $('weekLabel').appendChild(document.createTextNode(dayShort(monday) + ' — ' + dayShort(addDays(monday, 4))));
    $('weekLabel').appendChild(h('span', { class: 'sub', text: monday === mondayOf(today()) ? 'эта неделя' : monday === addDays(mondayOf(today()), -7) ? 'прошлая неделя' : '' }));
    $('weekNext').disabled = monday >= mondayOf(today());
    $('reportStatus').textContent = 'загружаю…';
    api('GET', '/api/report?week=' + monday).then(function (r) {
      if (seq !== reportSeq) return;
      st.report = r;
      renderReport();
    }).catch(function (e) { if (seq === reportSeq) $('reportStatus').textContent = e.message; });
  }

  function cellMarks(s, day, n) { // массив «+», «−», «» по парам дня
    var out = [];
    for (var p = 1; p <= n; p++) {
      var v = s.marks[day] && s.marks[day][p];
      out.push(v === 1 ? '+' : v === 0 ? '−' : '');
    }
    return out;
  }

  function renderReport() {
    var r = st.report;
    $('reportStatus').textContent = r.final
      ? 'Итог недели подведён: ' + lockText(r.monday) + '.'
      : 'Неделя ещё идёт — данные предварительные. Итог: ' + lockText(r.monday) + ' (Ташкент).';

    var top = r.students.filter(function (s) { return s.minus > 0; }).sort(function (a, b) { return b.minus - a.minus; });
    var topEl = $('reportTop');
    topEl.innerHTML = '';
    if (r.students.length) {
      topEl.appendChild(h('p', { class: 'top3', text: top.length
        ? 'Больше всего пропусков: ' + top.slice(0, 5).map(function (s) { return s.name + ' — ' + s.minus; }).join(', ') + '.'
        : 'Пропусков за неделю нет.' }));
    }

    var tbl = $('reportTable');
    tbl.innerHTML = '';
    if (!r.students.length) { tbl.appendChild(h('tr', {}, [h('td', { class: 'empty', text: 'В этой группе нет учеников за эту неделю.' })])); return; }
    // Итоговые столбцы — сразу после имени, чтобы на телефоне были видны без прокрутки.
    tbl.appendChild(h('thead', {}, [h('tr', {}, [h('th', { class: 'nm', text: 'Ученик' }), h('th', { text: '−' }), h('th', { text: '+' })]
      .concat(r.days.map(function (d) { return h('th', {}, [WD_SHORT[wd(d)], h('br'), dayShort(d)]); })))]));
    var body = h('tbody');
    r.students.forEach(function (s) {
      var tr = h('tr', { class: s.active ? '' : 'gone' }, [
        h('td', { class: 'nm', text: s.name + (s.active ? '' : ' (удалён)') }),
        h('td', { class: s.minus ? 'tot-m' : '', text: String(s.minus) }),
        h('td', { class: 'tot-p', text: String(s.plus) })
      ]);
      r.days.forEach(function (d) {
        var td = h('td', { class: 'cell' });
        var marks = cellMarks(s, d, r.pairsUsed[d]);
        marks.forEach(function (m) { td.appendChild(h('span', { class: m === '+' ? 'c-plus' : m === '−' ? 'c-minus' : '', text: m || '·' })); });
        if (!marks.length) td.textContent = '';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    tbl.appendChild(body);
  }

  function csvCell(v) {
    v = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; // Excel не должен принимать текст за формулу
    return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function reportCsv() {
    var r = st.report;
    if (!r || !r.students.length) { toast('Нечего выгружать.', true); return; }
    var head = ['Ученик'].concat(r.days.map(function (d) { return WD_SHORT[wd(d)] + ' ' + dayShort(d); })).concat(['Пропуски', 'Был']);
    var lines = [head.map(csvCell).join(';')];
    r.students.forEach(function (s) {
      var row = [s.name + (s.active ? '' : ' (удалён)')];
      r.days.forEach(function (d) {
        row.push(cellMarks(s, d, r.pairsUsed[d]).map(function (m) { return m || '·'; }).join(' ').replace(/−/g, 'н').replace(/\+/g, 'б'));
      });
      lines.push(row.map(csvCell).concat([s.minus, s.plus]).join(';'));
    });
    lines.push('');
    lines.push(csvCell('б — был, н — не был, · — пара не отмечена. ' + (r.final ? 'Итог недели.' : 'Предварительно, неделя ещё идёт.')));
    var blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var a = h('a', { href: URL.createObjectURL(blob), download: 'посещаемость-' + r.group.name.replace(/[^0-9a-zа-яё-]+/gi, '_') + '-' + r.monday + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  /* ---------- Запуск ---------- */

  function init() {
    $('loginTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (!b) return;
      Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
      show('loginForm', b.dataset.tab === 'login');
      show('registerForm', b.dataset.tab === 'register');
    });
    $('loginForm').addEventListener('submit', onLogin);
    $('registerForm').addEventListener('submit', onRegister);
    $('adminForm').addEventListener('submit', onAdminLogin);
    Array.prototype.forEach.call(document.querySelectorAll('[data-logout]'), function (b) { b.addEventListener('click', logout); });

    $('newGroupForm').addEventListener('submit', onNewGroup);
    $('copyKey').addEventListener('click', function () {
      var key = $('keyValue').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(key) : Promise.reject()).then(function () { toast('Ключ скопирован'); })
        .catch(function () { prompt('Скопируйте ключ:', key); });
    });
    $('toGroups').addEventListener('click', showAdmin);

    $('groupTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (b) setTab(b.dataset.tab);
    });
    $('pairList').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-pair]');
      if (!b) return;
      st.pair = Number(b.dataset.pair);
      renderMarks();
    });
    $('dayPrev').addEventListener('click', function () { goDay(-1); });
    $('dayNext').addEventListener('click', function () { goDay(1); });
    $('allPlus').addEventListener('click', allPlus);
    $('addStudentForm').addEventListener('submit', onAddStudent);
    $('pairsPerDay').addEventListener('change', onPairsChange);
    $('weekPrev').addEventListener('click', function () { st.monday = addDays(st.monday, -7); loadReport(); });
    $('weekNext').addEventListener('click', function () {
      if (st.monday >= mondayOf(today())) return;
      st.monday = addDays(st.monday, 7); loadReport();
    });
    $('reportCsv').addEventListener('click', reportCsv);

    // Вернулись в приложение — подтягиваем свежие данные (могли отмечать с другого устройства).
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !st.group || $('groupScreen').classList.contains('hidden')) return;
      if (st.tab === 'mark') loadDay(); else if (st.tab === 'report') loadReport();
    });

    if (!API) { showLogin('Не указан адрес сервера в config.js.'); return; }
    st.token = lsGet('att_token');
    if (!st.token) { showLogin(); return; }
    loadMe().catch(function (e) { if (e.status !== 401) showLogin(e.message); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
