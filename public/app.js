const app = document.querySelector('#app');
const header = document.querySelector('#site-header');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');

const state = { bootstrap: null, request: 0, modalReturnFocus: null };

const statusLabels = {
  DRAFT: 'Черновик', PUBLISHED: 'Опубликована', REVIEWING: 'Идёт отбор', ASSIGNED: 'Исполнитель выбран',
  IN_PROGRESS: 'В работе', SUBMITTED: 'Результат отправлен', ACCEPTED: 'Результат принят',
  REJECTED: 'Отклонена', CLOSED: 'Закрыта', SHORTLISTED: 'В шорт-листе', WITHDRAWN: 'Отозван',
};
const formatLabels = { REMOTE: 'Удалённо', HYBRID: 'Гибрид', ONSITE: 'На месте' };
const workSteps = ['ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED', 'CLOSED'];
const MIN_PROJECT_PRICE = 1_000;
const MAX_PROJECT_PRICE = 100_000_000;
const MIN_HOURLY_RATE = 100;
const MAX_HOURLY_RATE = 100_000;

function isCustomer(user = state.bootstrap?.user) {
  return Boolean(user && !user.isAdmin && user.primaryRole === 'CUSTOMER');
}

function isExecutor(user = state.bootstrap?.user) {
  return Boolean(user && !user.isAdmin && user.primaryRole === 'EXECUTOR');
}

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function money(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0)) + ' ₽';
}

function date(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${value.slice(0, 10)}T00:00:00`));
}

function dateTime(value) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dateWithOffset(days = 0) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + days);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoToInputDate(value = '') {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

function inputDateToIso(value = '') {
  const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return '';
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function initials(name = '') {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function tags(items = [], className = '') {
  const safeItems = Array.isArray(items) ? items : [];
  return `<div class="tag-list">${safeItems.map((item) => `<span class="tag ${className}">${esc(item)}</span>`).join('')}</div>`;
}

function statusBadge(status) {
  return `<span class="status ${String(status).toLowerCase()}">${esc(statusLabels[status] || status)}</span>`;
}

function backControl(label, fallback) {
  return `<a class="back-link" href="${esc(fallback)}" data-link>← ${esc(label)}</a>`;
}

function matchDetails(match) {
  if (!match) return '';
  return `<div class="match-details"><strong>Почему такой результат</strong>
    ${match.matchedSkills?.length ? `<div class="match-line good">✓ Совпало: ${esc(match.matchedSkills.join(', '))}</div>` : ''}
    ${match.missingSkills?.length ? `<div class="match-line missing">× Не указано в профиле: ${esc(match.missingSkills.join(', '))}</div>` : ''}
    <small>${esc(match.explanation)}</small>
  </div>`;
}

function setTitle(title = '') {
  document.title = title ? `${title} — Биржа талантов` : 'Биржа талантов — задачи находят исполнителей';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие');
  return data;
}

function toast(message, type = '') {
  toastRoot.innerHTML = `<div class="toast ${type}">${esc(message)}</div>`;
  setTimeout(() => { toastRoot.innerHTML = ''; }, 3300);
}

function navigate(path) {
  history.pushState({}, '', path);
  modalRoot.innerHTML = '';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeModal() {
  modalRoot.innerHTML = '';
  state.modalReturnFocus?.focus?.();
  state.modalReturnFocus = null;
}

function renderHeader() {
  const user = state.bootstrap?.user;
  const current = location.pathname;
  const active = (path) => current === path || (path !== '/' && current.startsWith(path)) ? 'active' : '';
  const userChip = !user
    ? ''
    : isExecutor(user)
      ? `<a class="user-chip user-chip--link" href="/profile/me" data-link title="Открыть профиль компетенций"><span class="avatar">${esc(initials(user.name))}</span><span>${esc(user.name)}</span></a>`
      : `<div class="user-chip user-chip--static" aria-label="Текущий пользователь: ${esc(user.name)}"><span class="avatar">${esc(initials(user.name))}</span><span>${esc(user.name)}</span></div>`;
  header.innerHTML = `
    <div class="header-inner">
      <a class="brand" href="/" data-link><span class="brand-mark">Т</span><span><b>Биржа талантов</b><small>Город находит тех, кто умеет</small></span></a>
      <button class="icon-btn mobile-menu-btn" data-action="toggle-nav" aria-controls="main-nav" aria-expanded="false" aria-label="Открыть меню">☰</button>
      <nav class="nav" id="main-nav" aria-label="Основная навигация">
        <a class="${active('/tasks')}" href="/tasks" data-link>Задачи</a>
        ${user && !user.isAdmin ? `<a class="${active('/my-tasks')}" href="/my-tasks" data-link>${isCustomer(user) ? 'Мои задачи' : 'Моя работа'}</a>` : ''}
        ${isCustomer(user) ? `<a class="${active('/applications')}" href="/applications" data-link>Отклики на мои задачи</a>` : ''}
        ${user?.isAdmin ? `<a class="${active('/admin')}" href="/admin" data-link>Модерация</a>` : ''}
      </nav>
      <div class="header-actions">
        ${user ? `
          ${isCustomer(user) ? '<a class="btn btn-primary hide-mobile" href="/tasks/create" data-link>Создать задачу</a>' : ''}
          ${userChip}
          <button class="btn btn-ghost logout-btn" data-action="logout" aria-label="Выйти из аккаунта">Выйти</button>
        ` : `
          <a class="btn btn-ghost" href="/login" data-link>Войти</a>
          <a class="btn btn-primary" href="/register" data-link>Присоединиться</a>
        `}
      </div>
    </div>`;
}

function loading() {
  app.innerHTML = '<div class="page-shell"><div class="loading-block"></div><div class="loading-block short"></div></div>';
}

function empty(title, copy, action = '') {
  return `<div class="empty"><div class="empty-icon">○</div><h3>${esc(title)}</h3><p>${esc(copy)}</p>${action}</div>`;
}

function taskCard(task, extra = '') {
  return `<a class="task-card" href="/tasks/${task.id}" data-link>
    <div class="task-card-head"><span class="tag brand">${esc(task.category)}</span>${task.match ? `<span class="match-pill">${task.match.score}% по компетенциям</span>` : statusBadge(task.status)}</div>
    <h3>${esc(task.title)}</h3>
    <p>${esc(task.description)}</p>
    <div class="task-meta"><span>${money(task.budget)}</span><span>до ${date(task.deadline)}</span><span>${esc(formatLabels[task.format])}</span><span>${esc(task.location)}</span></div>
    <div class="task-bottom">${tags(task.skills.slice(0, 4))}<span class="muted small">${Number(task.applicationCount || 0)} откликов${extra ? ` · ${esc(extra)}` : ''}</span></div>
  </a>`;
}

function homePage() {
  setTitle('');
  const stats = state.bootstrap.stats;
  const user = state.bootstrap.user;
  const heroActions = user?.isAdmin
    ? '<a class="btn btn-accent btn-lg" href="/admin" data-link>Открыть модерацию</a><a class="btn btn-secondary btn-lg" href="/tasks" data-link>Посмотреть задачи</a>'
    : isCustomer(user)
      ? '<a class="btn btn-accent btn-lg" href="/tasks/create" data-link>Создать задачу</a><a class="btn btn-secondary btn-lg" href="/my-tasks" data-link>Мои задачи</a>'
      : isExecutor(user)
        ? '<a class="btn btn-accent btn-lg" href="/tasks" data-link>Найти задачу</a><a class="btn btn-secondary btn-lg" href="/my-tasks" data-link>Моя работа</a>'
        : '<a class="btn btn-accent btn-lg" href="/tasks/create" data-link>Мне нужна помощь</a><a class="btn btn-secondary btn-lg" href="/tasks" data-link>Хочу решать задачи</a>';
  app.innerHTML = `
    <section class="hero">
      <div class="hero-inner">
        <div>
          <p class="eyebrow">Биржа задач · Город талантов</p>
          <h1>Задачи города находят тех, кто <em>умеет</em></h1>
          <p class="lead">Опубликуйте реальную задачу и выберите исполнителя — или найдите проект, которому нужны именно ваши навыки.</p>
          <div class="hero-actions">${heroActions}</div>
          <div class="hero-proof"><span>Понятные условия</span><span>Подбор по навыкам</span><span>Прозрачный статус</span></div>
        </div>
        <div class="hero-board" aria-label="Пример подбора исполнителей">
          <div class="mini-task">
            <span class="label">Подходящие исполнители</span>
            <h3>Контроль заполненности урн</h3>
            ${[['Иван Ковалёв','IoT · ESP32 · CV · Python','100%'],['Алексей Громов','IoT · ESP32 · Python','75%'],['Илья Брагин','ESP32','25%']].map(([name, skills, score]) => `<div class="candidate"><span class="avatar">${initials(name)}</span><div><strong>${name}</strong><small>${skills}</small></div><span class="score" title="Совпадение по указанным компетенциям">${score}</span></div>`).join('')}
          </div>
        </div>
      </div>
    </section>
    <section class="stats-strip"><div class="stats-inner">
      <div class="stat"><strong>${Number(stats.tasks)}</strong><span>актуальных задач в каталоге</span></div>
      <div class="stat"><strong>${Number(stats.executors)}</strong><span>профиля с компетенциями</span></div>
      <div class="stat"><strong>${Number(stats.assignments)}</strong><span>назначений зафиксировано</span></div>
    </div></section>
    <section class="section"><div class="section-inner">
      <div class="section-head"><div><p class="eyebrow">Один рабочий цикл</p><h2>От задачи — к результату</h2></div><p>Никакой сложной биржи. Только шаги, которые нужны для первого реального назначения.</p></div>
      <div class="steps">
        <article class="step"><h3>Опишите задачу</h3><p>Зафиксируйте ожидаемый результат, нужные навыки, бюджет и срок по короткому шаблону.</p></article>
        <article class="step"><h3>Сравните отклики</h3><p>Смотрите условия, профиль и объяснимый процент совпадения навыков каждого кандидата.</p></article>
        <article class="step"><h3>Получите результат</h3><p>Назначьте исполнителя, следите за статусом и примите работу в одном прозрачном процессе.</p></article>
      </div>
    </div></section>
    <section class="section" style="padding-top:0"><div class="section-inner"><div class="cta-band">
      <h2>${isExecutor(user) ? 'Готовы применить свои навыки в реальной задаче?' : 'Есть задача, которую давно пора сдвинуть с места?'}</h2><a class="btn btn-accent btn-lg" href="${isExecutor(user) ? '/tasks' : user?.isAdmin ? '/admin' : '/tasks/create'}" data-link>${isExecutor(user) ? 'Найти задачу' : user?.isAdmin ? 'Открыть модерацию' : 'Опубликовать задачу'}</a>
    </div></div></section>`;
}

async function tasksPage() {
  setTitle('Задачи');
  const params = new URLSearchParams(location.search);
  const data = await api(`/api/tasks?${params}`);
  app.innerHTML = `<div class="page-shell">
    <div class="page-title-row"><div><p class="eyebrow">Открытая биржа</p><h1>Задачи</h1><p class="lead">${isExecutor() ? 'Выберите проект, в котором ваши навыки принесут видимый результат.' : 'Открытые задачи городских проектов и команд.'}</p></div>${isCustomer() ? '<a class="btn btn-primary btn-lg" href="/tasks/create" data-link>Создать задачу</a>' : ''}</div>
    <div class="catalog-layout">
      <form class="filters" id="filters-form" novalidate>
        <div class="filter-title"><strong>Фильтры</strong><button class="btn btn-ghost btn-sm" type="button" data-action="clear-filters">Сбросить</button></div>
        <div class="field"><label for="q">Поиск</label><input id="q" name="q" maxlength="80" value="${esc(params.get('q') || '')}" placeholder="Название или навык" /></div>
        <div class="field"><label for="category">Категория</label><select id="category" name="category"><option value="">Все категории</option>${state.bootstrap.categories.map((item) => `<option ${params.get('category') === item ? 'selected' : ''}>${esc(item)}</option>`).join('')}</select></div>
        <div class="field"><label for="skill">Компетенция</label><input id="skill" name="skill" maxlength="50" value="${esc(params.get('skill') || '')}" placeholder="Например, Python" /></div>
        <div class="field"><label for="format">Формат</label><select id="format" name="format"><option value="">Любой</option>${state.bootstrap.formats.map((item) => `<option value="${item}" ${params.get('format') === item ? 'selected' : ''}>${formatLabels[item]}</option>`).join('')}</select></div>
        <div class="field"><label for="budgetMax">Бюджет до, ₽</label><input id="budgetMax" name="budgetMax" type="number" min="${MIN_PROJECT_PRICE}" max="${MAX_PROJECT_PRICE}" value="${esc(params.get('budgetMax') || '')}" placeholder="200 000" /></div>
        <div class="field"><label for="deadline">Завершить до</label><input id="deadline" name="deadline" type="text" inputmode="numeric" maxlength="10" pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}" data-date-input data-min-date="${dateWithOffset(0)}" data-max-date="${dateWithOffset(730)}" value="${esc(isoToInputDate(params.get('deadline') || ''))}" placeholder="ДД/ММ/ГГГГ" /></div>
        <button class="btn btn-primary btn-block" type="submit">Показать задачи</button>
      </form>
      <div><p class="muted small">Найдено: ${data.tasks.length}</p><div class="task-list">${data.tasks.length ? data.tasks.map(taskCard).join('') : empty('Задач не найдено', 'Попробуйте убрать часть фильтров или изменить запрос.', '<button class="btn btn-secondary" data-action="clear-filters">Сбросить фильтры</button>')}</div></div>
    </div>
  </div>`;
}

function applicationModal(task) {
  state.modalReturnFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="apply-title">
    <div class="modal-head"><div><p class="eyebrow">Отклик на задачу</p><h2 id="apply-title">Предложите решение</h2><p class="muted small">${esc(task.title)}</p></div><button class="icon-btn" data-action="close-modal" aria-label="Закрыть">×</button></div>
    <form id="application-form" data-task-id="${task.id}" novalidate>
      <div class="field"><label for="message">Как вы решите задачу?</label><textarea id="message" name="message" minlength="20" maxlength="1500" required placeholder="Коротко опишите подход, релевантный опыт и первый шаг"></textarea></div>
      <div class="field-row"><div class="field"><label for="proposedPrice">Стоимость, ₽</label><input id="proposedPrice" name="proposedPrice" type="number" min="${MIN_PROJECT_PRICE}" max="${MAX_PROJECT_PRICE}" step="1" value="${task.budget}" required /><small>Любая целая сумма от 1 000 до 100 млн ₽</small></div><div class="field"><label for="proposedDeadline">Срок результата</label><input id="proposedDeadline" name="proposedDeadline" type="text" inputmode="numeric" maxlength="10" pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}" data-date-input data-min-date="${dateWithOffset(0)}" data-max-date="${esc(task.deadline)}" value="${esc(isoToInputDate(task.deadline))}" required placeholder="ДД/ММ/ГГГГ" /><small>Формат ДД/ММ/ГГГГ, не позже ${date(task.deadline)}</small></div></div>
      <div class="form-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Отмена</button><button class="btn btn-primary" type="submit">Отправить отклик</button></div>
    </form>
  </div></div>`;
  requestAnimationFrame(() => modalRoot.querySelector('textarea')?.focus());
}

function candidateCard(application, canSelect = true) {
  const person = application.executor;
  return `<article class="candidate-card">
    <a href="/profile/${person.id}" data-link><span class="avatar">${esc(initials(person.name))}</span></a>
    <div class="candidate-body"><a href="/profile/${person.id}" data-link><strong>${esc(person.name)}</strong></a><p>${esc(application.message)}</p>${tags(person.skills.slice(0, 5))}${matchDetails(application.match)}</div>
    <div class="candidate-side"><span class="match-pill">${application.match.score}% по компетенциям</span><strong class="price" style="font-size:17px;margin-top:10px">${money(application.proposedPrice)}</strong><small class="muted">до ${date(application.proposedDeadline)}</small>${canSelect && application.status === 'SUBMITTED' ? `<button class="btn btn-primary btn-sm" data-action="select-executor" data-id="${application.id}">Выбрать исполнителя</button>` : `<div style="margin-top:10px">${statusBadge(application.status)}</div>`}</div>
  </article>`;
}

async function taskDetailPage(id) {
  const data = await api(`/api/tasks/${id}`);
  const { task } = data;
  setTitle(task.title);
  const user = state.bootstrap.user;
  const isOwner = isCustomer(user) && user.id === task.customerId;
  const showRecommendations = isOwner && ['DRAFT', 'PUBLISHED', 'REVIEWING'].includes(task.status);
  const workAvailable = ['ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED', 'CLOSED'].includes(task.status) && user && (isOwner || user.isAdmin || user.id === task.assignedExecutorId);
  let action = '';
  if (workAvailable) action = `<a class="btn btn-primary btn-block" href="/tasks/${task.id}/work" data-link>Открыть рабочую страницу</a>`;
  else if (data.myApplication) {
    const applicationMessages = {
      SUBMITTED: 'Отклик отправлен. Заказчик ещё рассматривает кандидатов.',
      SHORTLISTED: 'Ваш отклик попал в шорт-лист заказчика.',
      REJECTED: 'Заказчик выбрал другого исполнителя. Ваш отклик сохранён в истории.',
      WITHDRAWN: 'Этот отклик был отозван.',
    };
    action = `<div class="result-box small"><strong>${esc(statusLabels[data.myApplication.status] || data.myApplication.status)}</strong><br>${esc(applicationMessages[data.myApplication.status] || 'Статус отклика обновлён.')}</div><a class="btn btn-secondary btn-block" style="margin-top:8px" href="/my-tasks?tab=applied" data-link>Мои отклики</a>`;
  }
  else if (isOwner && task.status === 'DRAFT') action = `<a class="btn btn-secondary btn-block" href="/tasks/${task.id}/edit" data-link>Редактировать черновик</a><button class="btn btn-primary btn-block" style="margin-top:8px" data-action="publish-task" data-id="${task.id}">Опубликовать задачу</button>`;
  else if (isOwner && ['PUBLISHED', 'REVIEWING'].includes(task.status)) action = `<a class="btn btn-secondary btn-block" href="/tasks/${task.id}/edit" data-link>Редактировать задачу</a><p class="muted micro" style="margin:10px 0 0">Изменения увидят все откликнувшиеся исполнители.</p>`;
  else if (!isOwner && ['PUBLISHED', 'REVIEWING'].includes(task.status)) {
    if (task.expired) action = '<div class="result-box small">Срок задачи истёк — новые отклики больше не принимаются.</div>';
    else if (!user) action = `<a class="btn btn-primary btn-block" href="/login?next=/tasks/${task.id}" data-link>Войти и откликнуться</a>`;
    else if (!isExecutor(user)) action = '<div class="result-box small">Откликаться на задачи может только исполнитель.</div>';
    else if (!user.profileCompleted) action = `<a class="btn btn-primary btn-block" href="/profile/me" data-link>Заполнить профиль для отклика</a>`;
    else action = `<button class="btn btn-primary btn-block" data-action="open-application" data-task='${esc(JSON.stringify(task))}'>Откликнуться</button>`;
  }
  app.innerHTML = `<div class="page-shell">
    ${backControl('Все задачи', '/tasks')}
    <div class="detail-grid">
      <div class="detail-main">
        <article class="detail-hero"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center">${statusBadge(task.status)}<span class="muted small">Задача №${task.id}</span></div><h1>${esc(task.title)}</h1><div class="task-context"><h2>Зачем и что нужно сделать</h2><p class="detail-copy">${esc(task.description)}</p></div>${tags(task.skills, 'brand')}</article>
        <section class="detail-section"><h2>Что должно получиться</h2><div class="result-box">${esc(task.expectedResult)}</div></section>
        ${isOwner ? `<section class="detail-section"><div class="section-head" style="margin-bottom:12px"><div><h2>Отклики</h2><p>${data.applications.length ? 'Сравните условия и подтверждённые совпадения.' : 'Отклики появятся здесь после публикации.'}</p></div></div>${data.applications.length ? data.applications.map((item) => candidateCard(item, ['PUBLISHED','REVIEWING'].includes(task.status))).join('') : empty('Пока нет откликов', 'Поделитесь ссылкой на задачу с подходящими специалистами.')}</section>` : ''}
        ${showRecommendations ? `<section class="detail-section"><h2>Подходящие исполнители</h2><p class="muted">Подбор учитывает только указанные компетенции. Процент помогает сравнить профили, но не оценивает человека целиком.</p>${data.recommendations?.length ? data.recommendations.map(({ profile, match }) => `<article class="candidate-card"><a href="/profile/${profile.id}" data-link><span class="avatar">${esc(initials(profile.name))}</span></a><div class="candidate-body"><a href="/profile/${profile.id}" data-link><strong>${esc(profile.name)}</strong></a><p>${esc(profile.bio)}</p>${tags(profile.skills.slice(0,5))}${matchDetails(match)}</div><div class="candidate-side"><span class="match-pill">${match.score}% по компетенциям</span></div></article>`).join('') : empty('Пока не нашли совпадений', 'Попробуйте уточнить или расширить список компетенций. После публикации специалисты также смогут откликнуться сами.', `<a class="btn btn-secondary" href="/tasks/${task.id}/edit" data-link>Изменить требования</a>`)}</section>` : ''}
      </div>
      <aside class="sidebar">
        <div class="side-card"><span class="price">${money(task.budget)}</span><span class="muted small">бюджет задачи</span><div class="side-list"><div><span>Срок</span><strong>${date(task.deadline)}</strong></div><div><span>Формат</span><strong>${esc(formatLabels[task.format])}</strong></div><div><span>Локация</span><strong>${esc(task.location)}</strong></div><div><span>Откликов</span><strong>${task.applicationCount || 0}</strong></div></div>${task.match ? `<div class="result-box small" style="margin-bottom:14px"><strong>${task.match.score}% по компетенциям</strong>${matchDetails(task.match)}</div>` : ''}${action}</div>
        <div class="side-card"><p class="muted micro" style="text-transform:uppercase;letter-spacing:.08em">Заказчик</p><div class="owner"><span class="avatar">${esc(initials(task.customer.name))}</span><div><strong>${esc(task.customer.name)}</strong><small>${task.customer.publishedTasks ?? 0} опубликовано · ${task.customer.completedTasks ?? 0} завершено</small></div></div>${task.customer.memberSince ? `<p class="muted micro trust-note">На платформе с ${new Date(task.customer.memberSince).getFullYear()} года</p>` : ''}</div>
      </aside>
    </div>
  </div>`;
}

function taskFormPage(task = null) {
  if (!state.bootstrap.user) return authGate('Чтобы создать задачу, войдите как заказчик.');
  if (!isCustomer()) return accessDenied('Создавать и публиковать задачи может только заказчик.');
  const editing = Boolean(task);
  const draft = task?.status === 'DRAFT';
  setTitle(editing ? 'Редактирование задачи' : 'Новая задача');
  const minDate = dateWithOffset(1);
  const maxDate = dateWithOffset(730);
  app.innerHTML = `<div class="page-shell narrow">${backControl(editing ? 'К задаче' : 'Мои задачи', editing ? `/tasks/${task.id}` : '/my-tasks')}<div class="page-title-row"><div><p class="eyebrow">${editing ? 'Редактирование' : 'Новая задача'}</p><h1>${editing ? 'Уточните задачу' : 'Что нужно сделать?'}</h1><p class="lead">Опишите результат так, чтобы специалист мог оценить объём работы.</p></div></div>
    <form class="form-card" id="task-form" novalidate ${editing ? `data-task-id="${task.id}"` : ''}>
      <section class="form-section"><div class="form-section-head"><h3>Суть задачи</h3><p>Короткое название и контекст проблемы.</p></div>
        <div class="field"><label for="title">Название</label><input id="title" name="title" minlength="5" maxlength="120" required value="${esc(task?.title || '')}" placeholder="Например, прототип умной урны" /></div>
        <div class="field"><label for="description">Зачем и что нужно сделать</label><textarea id="description" name="description" minlength="30" maxlength="5000" required placeholder="Опишите обычными словами: в чём проблема, для кого её решаем, что нужно сделать и какие есть ограничения">${esc(task?.description || '')}</textarea><small>Начните с цели — техническое ТЗ можно уточнить вместе с исполнителем.</small></div>
        <div class="field"><label for="expectedResult">Ожидаемый результат</label><textarea id="expectedResult" name="expectedResult" minlength="10" maxlength="1000" required placeholder="Например: работающий прототип, исходный код и инструкция запуска">${esc(task?.expectedResult || '')}</textarea></div>
      </section>
      <section class="form-section"><div class="form-section-head"><h3>Кого ищем</h3><p>Категория и 3–5 ключевых компетенций улучшают подбор.</p></div>
        <div class="field-row"><div class="field"><label for="category">Категория</label><select id="category" name="category" required><option value="">Выберите</option>${state.bootstrap.categories.map((item) => `<option ${task?.category === item ? 'selected' : ''}>${esc(item)}</option>`).join('')}</select></div><div class="field"><label for="skills">Компетенции</label><input id="skills" name="skills" maxlength="600" required value="${esc(task?.skills?.join(', ') || '')}" placeholder="ESP32, IoT, Sensors" /><small>От 1 до 12 навыков через запятую</small></div></div>
      </section>
      <section class="form-section"><div class="form-section-head"><h3>Условия</h3><p>Эти данные помогут получить предметные отклики.</p></div>
        <div class="field-row"><div class="field"><label for="budget">Бюджет, ₽</label><input id="budget" name="budget" type="number" min="${MIN_PROJECT_PRICE}" max="${MAX_PROJECT_PRICE}" step="1" required value="${task?.budget ?? ''}" placeholder="125500" /><small>Любая целая сумма от 1 000 до 100 млн ₽</small></div><div class="field"><label for="deadline">Срок результата</label><input id="deadline" name="deadline" type="text" inputmode="numeric" maxlength="10" pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}" data-date-input data-min-date="${minDate}" data-max-date="${maxDate}" value="${esc(isoToInputDate(task?.deadline || ''))}" required placeholder="ДД/ММ/ГГГГ" /><small>Формат ДД/ММ/ГГГГ. Допустимо с ${date(minDate)} по ${date(maxDate)}</small></div></div>
        <div class="field-row"><div class="field"><label for="location">Локация</label><input id="location" name="location" maxlength="100" required value="${esc(task?.location || 'Новосибирск')}" /></div><div class="field"><label for="format">Формат</label><select id="format" name="format" required>${state.bootstrap.formats.map((item) => `<option value="${item}" ${task?.format === item ? 'selected' : ''}>${formatLabels[item]}</option>`).join('')}</select></div></div>
        ${!editing || draft ? `<label class="checkbox"><input type="checkbox" name="publish" ${editing ? '' : 'checked'} /><span><strong>${editing ? 'Опубликовать после сохранения' : 'Сразу опубликовать'}</strong><br>${editing ? 'После проверки задача появится в каталоге.' : 'Снимите отметку, чтобы сохранить черновик.'}</span></label>` : ''}
      </section>
      <div class="form-actions"><a class="btn btn-secondary" href="${editing ? `/tasks/${task.id}` : '/my-tasks'}" data-link>Отмена</a><button class="btn btn-primary btn-lg" type="submit">${editing ? 'Сохранить изменения' : 'Создать задачу'}</button></div>
    </form>
  </div>`;
}

function taskCreatePage() {
  return taskFormPage();
}

async function taskEditPage(id) {
  if (!state.bootstrap.user) return authGate('Чтобы редактировать задачу, войдите в аккаунт.');
  if (!isCustomer()) return accessDenied('Редактировать задачу может только заказчик.');
  const { task } = await api(`/api/tasks/${id}`);
  const user = state.bootstrap.user;
  if (user.id !== task.customerId && !user.isAdmin) return accessDenied('Редактировать задачу может только её заказчик.');
  if (!['DRAFT', 'PUBLISHED', 'REVIEWING'].includes(task.status)) return accessDenied('После назначения исполнителя условия задачи менять нельзя.');
  return taskFormPage(task);
}

function authGate(copy) {
  setTitle('Нужен вход');
  const next = `${location.pathname}${location.search}`;
  app.innerHTML = `<div class="page-shell narrow">${empty('Сначала войдите', copy, `<a class="btn btn-primary" href="/login?next=${encodeURIComponent(next)}" data-link>Войти</a> <a class="btn btn-secondary" href="/" data-link>На главную</a>`)}</div>`;
}

function accessDenied(copy) {
  setTitle('Нет доступа');
  app.innerHTML = `<div class="page-shell narrow">${empty('Действие недоступно', copy, '<a class="btn btn-primary" href="/my-tasks" data-link>Мои задачи</a> <a class="btn btn-secondary" href="/tasks" data-link>Каталог</a>')}</div>`;
}

function authPage(mode) {
  const register = mode === 'register';
  setTitle(register ? 'Регистрация' : 'Вход');
  app.innerHTML = `<div class="auth-shell">
    <section class="auth-form"><div class="auth-form-inner"><p class="eyebrow">${register ? 'Новый участник' : 'С возвращением'}</p><h1>${register ? 'Начните с роли' : 'Войдите в кабинет'}</h1><p class="muted">${register ? 'Один аккаунт сможет и публиковать, и решать задачи.' : 'Продолжите работу с задачами и откликами.'}</p>
      <form id="${register ? 'register-form' : 'login-form'}">
        ${register ? `<div class="field"><label for="name">Имя или название команды</label><input id="name" name="name" minlength="2" maxlength="80" required autocomplete="name" /></div>` : ''}
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" maxlength="160" required autocomplete="email" /></div>
        <div class="field"><label for="password">Пароль</label><input id="password" name="password" type="password" minlength="8" maxlength="100" required autocomplete="${register ? 'new-password' : 'current-password'}" /></div>
        ${register ? `<div class="field"><span class="field-label">Основная роль</span><div class="role-choice"><label class="role-option"><input type="radio" name="role" value="CUSTOMER" checked /><strong>Заказчик</strong><small>Публикую задачи</small></label><label class="role-option"><input type="radio" name="role" value="EXECUTOR" /><strong>Исполнитель</strong><small>Ищу проекты</small></label></div></div>` : ''}
        <button class="btn btn-primary btn-block btn-lg" type="submit">${register ? 'Создать аккаунт' : 'Войти'}</button>
      </form>
      <p class="small muted" style="text-align:center;margin-top:18px">${register ? 'Уже есть аккаунт? <a class="text-link" href="/login" data-link>Войти</a>' : 'Впервые здесь? <a class="text-link" href="/register" data-link>Создать аккаунт</a>'}</p>
      ${!register ? `<div class="demo-box"><small>Быстрый вход для демонстрации · пароль demo1234</small><div class="demo-actions"><button class="btn btn-secondary btn-sm" data-action="demo-login" data-email="customer@demo.city">Заказчик</button><button class="btn btn-secondary btn-sm" data-action="demo-login" data-email="ivan@demo.city">Исполнитель</button><button class="btn btn-secondary btn-sm" data-action="demo-login" data-email="admin@talent.city">Модератор</button></div></div>` : ''}
    </div></section>
    <aside class="auth-art"><div class="auth-quote"><p>«Реальные задачи. Реальные люди. Видимый результат.»</p><small>Город талантов · Новосибирск</small></div></aside>
  </div>`;
}

async function profilePage(id) {
  const me = id === 'me';
  if (me && !state.bootstrap.user) return authGate('Профиль исполнителя доступен после входа.');
  if (me && !isExecutor()) return accessDenied('Личный профиль компетенций доступен только исполнителю.');
  const data = await api(me ? '/api/profile/me' : `/api/profile/${id}`);
  const profile = data.profile;
  setTitle(me ? 'Мой профиль' : profile.name);
  if (me) {
    app.innerHTML = `<div class="page-shell narrow">${backControl('К задачам', '/tasks')}<div class="page-title-row"><div><p class="eyebrow">Профиль исполнителя</p><h1>${profile.completed ? 'Обновите профиль' : 'Расскажите, что умеете'}</h1><p class="lead">Конкретные навыки помогают задачам найти вас.</p></div></div>
      <form class="form-card" id="profile-form">
        <div class="field"><label for="bio">О себе</label><textarea id="bio" name="bio" minlength="20" maxlength="1000" required placeholder="Какую пользу вы приносите проектам?">${esc(profile.bio)}</textarea></div>
        <div class="field"><label for="skills">Компетенции</label><input id="skills" name="skills" maxlength="600" value="${esc((Array.isArray(profile.skills) ? profile.skills : []).join(', '))}" required placeholder="Python, ROS2, Computer Vision" /><small>От 1 до 12 конкретных навыков через запятую</small></div>
        <div class="field"><label for="experience">Опыт</label><textarea id="experience" name="experience" minlength="20" maxlength="2000" required placeholder="Проекты, результаты, годы опыта">${esc(profile.experience)}</textarea></div>
        <div class="field"><label for="portfolio">Портфолио</label><input id="portfolio" name="portfolio" maxlength="500" value="${esc(profile.portfolio)}" placeholder="Ссылка или короткое описание" /></div>
        <div class="field-row"><div class="field"><label for="location">Локация</label><input id="location" name="location" maxlength="100" value="${esc(profile.location)}" required /></div><div class="field"><label for="workFormat">Формат работы</label><select id="workFormat" name="workFormat">${state.bootstrap.formats.map((item) => `<option value="${item}" ${profile.workFormat === item ? 'selected' : ''}>${formatLabels[item]}</option>`).join('')}</select></div></div>
        <div class="field-row"><div class="field"><label for="availability">Доступность</label><input id="availability" name="availability" maxlength="200" value="${esc(profile.availability)}" required placeholder="Готов начать через неделю" /></div><div class="field"><label for="desiredRate">Желаемая ставка, ₽/час</label><input id="desiredRate" name="desiredRate" type="number" min="${MIN_HOURLY_RATE}" max="${MAX_HOURLY_RATE}" step="100" value="${profile.desiredRate ?? ''}" /><small>Необязательно, от 100 до 100 000 ₽</small></div></div>
        <div class="form-actions"><button class="btn btn-primary btn-lg" type="submit">Сохранить профиль</button></div>
      </form></div>`;
    return;
  }
  const reviews = data.reviews || [];
  const stats = data.stats || { assignments: 0, completedTasks: 0, activeTasks: 0, reviewsCount: reviews.length, averageRating: null };
  const average = stats.averageRating === null ? null : Number(stats.averageRating).toFixed(1);
  app.innerHTML = `<div class="page-shell medium">${backControl('Назад', '/tasks')}<section class="profile-hero"><span class="avatar lg">${esc(initials(profile.name))}</span><div><p class="eyebrow">Исполнитель</p><h1>${esc(profile.name)}</h1><p class="muted">${esc(profile.location || 'Локация не указана')} · ${esc(formatLabels[profile.workFormat])}${average ? ` · <span class="rating">★ ${average}</span>` : ''}</p></div></section>
    <div class="trust-stats"><div><strong>${stats.completedTasks}</strong><span>задач завершено</span></div><div><strong>${stats.activeTasks}</strong><span>сейчас в работе</span></div><div><strong>${stats.reviewsCount}</strong><span>отзывов</span></div></div>
    <div class="profile-grid"><div class="panel"><h2>О специалисте</h2><p class="detail-copy">${esc(profile.bio || 'Описание пока не заполнено.')}</p><h3>Компетенции</h3>${tags(profile.skills, 'brand')}<h3 style="margin-top:25px">Опыт</h3><p class="detail-copy">${esc(profile.experience || 'Не указан')}</p>${profile.portfolio ? `<h3 style="margin-top:25px">Портфолио</h3><p>${esc(profile.portfolio)}</p>` : ''}</div>
      <aside><div class="side-card"><h3>Доступность</h3><p class="muted small">${esc(profile.availability || 'Не указана')}</p>${profile.desiredRate ? `<span class="price" style="font-size:22px">${money(profile.desiredRate)}<small class="muted"> / час</small></span>` : ''}</div><div class="side-card" style="margin-top:16px"><h3>Отзывы · ${reviews.length}</h3>${reviews.length ? reviews.map((review) => `<article class="review"><span class="rating">${'★'.repeat(review.rating)}${'☆'.repeat(5-review.rating)}</span><p>${esc(review.text)}</p><small>${esc(review.author_name)} · ${esc(review.task_title)}</small></article>`).join('') : '<p class="muted small">Первый отзыв появится после завершённой задачи.</p>'}</div></aside>
    </div></div>`;
}

async function applicationsPage() {
  if (!state.bootstrap.user) return authGate('Отклики заказчика доступны после входа.');
  if (!isCustomer()) return accessDenied('Сравнивать отклики и выбирать исполнителя может только заказчик.');
  setTitle('Отклики');
  const data = await api('/api/applications');
  app.innerHTML = `<div class="page-shell medium">${backControl('Мои задачи', '/my-tasks')}<div class="page-title-row"><div><p class="eyebrow">Кабинет заказчика</p><h1>Отклики</h1><p class="lead">Сравните подход, условия и совпадение компетенций.</p></div></div>
    ${data.applications.length ? `<div class="panel">${data.applications.map((item) => `<div style="margin-bottom:7px"><a class="text-link small" href="/tasks/${item.taskId}" data-link>${esc(item.taskTitle)}</a></div>${candidateCard(item, true)}`).join('')}</div>` : empty('Откликов пока нет', 'После публикации задачи предложения исполнителей появятся здесь.', '<a class="btn btn-primary" href="/tasks/create" data-link>Создать задачу</a>')}
  </div>`;
}

function taskSection(title, copy, items, emptyCopy, emptyAction) {
  return `<section data-task-section="${esc(title)}"><div class="section-head" style="margin:0 0 16px"><div><h2 style="font-size:27px">${esc(title)}</h2><p>${esc(copy)}</p></div></div>${items.length ? `<div class="task-list">${items.map((item) => taskCard(item, item.myApplicationStatus ? statusLabels[item.myApplicationStatus] : '')).join('')}</div>` : empty('Здесь пока пусто', emptyCopy, emptyAction)}</section>`;
}

async function myTasksPage() {
  if (!state.bootstrap.user) return authGate('Личный список задач доступен после входа.');
  if (state.bootstrap.user.isAdmin) return accessDenied('Для модератора доступна операционная панель.');
  const data = await api('/api/my-tasks');
  if (isCustomer()) {
    setTitle('Мои задачи');
    const demoNote = state.bootstrap.user.email === 'customer@demo.city'
      ? '<div class="result-box small" style="margin-bottom:18px">Две задачи подготовлены для демонстрации. Остальные записи здесь — только задачи, созданные этим аккаунтом.</div>'
      : '';
    app.innerHTML = `<div class="page-shell"><div class="page-title-row"><div><p class="eyebrow">Кабинет заказчика</p><h1>Мои задачи</h1><p class="lead">Только задачи, созданные вами. Здесь можно публиковать их и выбирать исполнителей.</p></div><a class="btn btn-primary btn-lg" href="/tasks/create" data-link>Создать задачу</a></div>${demoNote}${taskSection('Созданные вами', 'Управляйте публикацией и выбирайте исполнителей.', data.created, 'Создайте первую задачу и опубликуйте её в каталоге.', '<a class="btn btn-primary" href="/tasks/create" data-link>Создать задачу</a>')}</div>`;
    return;
  }
  setTitle('Моя работа');
  const requestedTab = new URLSearchParams(location.search).get('tab');
  const activeTab = ['assigned', 'applied'].includes(requestedTab) ? requestedTab : 'assigned';
  app.innerHTML = `<div class="page-shell"><div class="page-title-row"><div><p class="eyebrow">Кабинет исполнителя</p><h1>Моя работа</h1><p class="lead">Назначенные вам задачи и отправленные вами отклики.</p></div><a class="btn btn-primary btn-lg" href="/tasks" data-link>Найти задачу</a></div>
    <div class="tabs" role="tablist" aria-label="Разделы работы"><button class="tab ${activeTab === 'assigned' ? 'active' : ''}" role="tab" aria-selected="${activeTab === 'assigned'}" aria-controls="task-tab-assigned" data-action="task-tab" data-tab="assigned">В работе · ${data.assigned.length}</button><button class="tab ${activeTab === 'applied' ? 'active' : ''}" role="tab" aria-selected="${activeTab === 'applied'}" aria-controls="task-tab-applied" data-action="task-tab" data-tab="applied">Мои отклики · ${data.applied.length}</button></div>
    <div id="task-tab-assigned" role="tabpanel" ${activeTab === 'assigned' ? '' : 'hidden'}>${taskSection('Назначенные вам', 'Задачи, где заказчик выбрал вас исполнителем.', data.assigned, 'Назначение появится после того, как заказчик выберет ваш отклик.', '<a class="btn btn-secondary" href="/tasks" data-link>Найти задачу</a>')}</div>
    <div id="task-tab-applied" role="tabpanel" ${activeTab === 'applied' ? '' : 'hidden'}>${taskSection('Ваши отклики', 'Следите за решением заказчика.', data.applied, 'Найдите подходящую задачу и отправьте предложение.', '<a class="btn btn-primary" href="/tasks" data-link>Перейти в каталог</a>')}</div>
  </div>`;
}

function workStatusTrack(current) {
  const currentIndex = workSteps.indexOf(current);
  return `<div class="status-track">${workSteps.map((status, index) => `<div class="status-step ${index < currentIndex ? 'done' : index === currentIndex ? 'current' : ''}">${statusLabels[status]}</div>`).join('')}</div>`;
}

function reviewForm(taskId) {
  return `<form id="review-form" data-task-id="${taskId}" class="form-section"><h3>Оставьте отзыв</h3><div class="field-row"><div class="field"><label for="rating">Оценка</label><select id="rating" name="rating">${[5,4,3,2,1].map((n) => `<option value="${n}">${'★'.repeat(n)} · ${n}</option>`).join('')}</select></div><div></div></div><div class="field"><label for="text">Комментарий</label><textarea id="text" name="text" minlength="10" maxlength="1000" required placeholder="Что получилось хорошо в совместной работе?"></textarea></div><button class="btn btn-primary" type="submit">Отправить отзыв</button></form>`;
}

async function workPage(id) {
  const data = await api(`/api/tasks/${id}/work`);
  const { task, assignment, history, reviews, viewerId, demoSwitch } = data;
  setTitle(`Работа: ${task.title}`);
  const isExecutor = viewerId === assignment.executorId;
  const isCustomer = viewerId === assignment.customerId;
  const reviewed = reviews.some((item) => Number(item.author_id) === viewerId);
  const waitingMessages = {
    ASSIGNED: isCustomer ? `Вы уже выбрали исполнителя — ${assignment.executorName}. Сейчас его ход: подтвердить начало работы.` : 'Назначение создано. Нажмите «Начать работу», чтобы заказчик увидел старт.',
    IN_PROGRESS: isCustomer ? 'Исполнитель работает над задачей. Следующее действие появится после отправки результата.' : 'Работа начата — отправьте результат, когда он будет готов.',
    SUBMITTED: isExecutor ? 'Результат передан заказчику. Ожидайте принятия или комментария на доработку.' : 'Результат ожидает проверки заказчиком.',
    ACCEPTED: isExecutor ? 'Заказчик принял результат. Он закроет задачу после завершения договорённостей.' : 'Результат принят — задачу можно закрыть.',
    CLOSED: 'Задача завершена. Если вы ещё не оставили отзыв, это можно сделать ниже.',
  };
  let action = `<div class="result-box small">${esc(waitingMessages[assignment.status] || 'Сейчас действие ожидается от другой стороны.')}</div>`;
  const nextRole = { ASSIGNED: 'EXECUTOR', IN_PROGRESS: 'EXECUTOR', SUBMITTED: 'CUSTOMER', ACCEPTED: 'CUSTOMER' }[assignment.status];
  if (demoSwitch && demoSwitch.role === nextRole) {
    action += `<div class="demo-turn"><p><strong>Демонстрационный режим:</strong> продолжите сценарий от лица участника, чей сейчас ход.</p><button class="btn btn-secondary" data-action="demo-login" data-email="${esc(demoSwitch.email)}" data-next="/tasks/${task.id}/work">Продолжить как ${esc(demoSwitch.name)}</button></div>`;
  }
  if (assignment.status === 'ASSIGNED' && isExecutor) action = `<div class="action-box"><h3>Можно начинать</h3><p>Подтвердите старт — заказчик увидит, что задача взята в работу.</p><button class="btn btn-primary" data-action="work-action" data-work-action="start" data-id="${task.id}">Начать работу</button></div>`;
  if (assignment.status === 'IN_PROGRESS' && isExecutor) action = `<div class="action-box"><h3>Отправить результат</h3>${assignment.revisionNote ? `<p><strong>Комментарий заказчика:</strong> ${esc(assignment.revisionNote)}</p>` : '<p>Опишите, что сделано, и приложите ссылку при необходимости.</p>'}<form id="result-form" data-task-id="${task.id}"><div class="field"><label for="resultNote">Описание результата</label><textarea id="resultNote" name="resultNote" minlength="20" maxlength="3000" required></textarea></div><div class="field"><label for="resultUrl">Ссылка</label><input id="resultUrl" name="resultUrl" type="url" maxlength="500" placeholder="https://…" /><small>Необязательно. Полная ссылка с https://</small></div><button class="btn btn-primary" type="submit">Передать заказчику</button></form></div>`;
  if (assignment.status === 'SUBMITTED' && isCustomer) action = `<div class="action-box"><h3>Результат готов к проверке</h3><p>Примите работу или верните с конкретным комментарием.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary" data-action="work-action" data-work-action="accept" data-id="${task.id}">Принять результат</button><button class="btn btn-secondary" data-action="open-revision" data-id="${task.id}">Вернуть на доработку</button></div></div>`;
  if (assignment.status === 'ACCEPTED' && isCustomer) action = `<div class="action-box"><h3>Результат принят</h3><p>Закройте задачу, когда все договорённости выполнены.</p><button class="btn btn-primary" data-action="work-action" data-work-action="close" data-id="${task.id}">Закрыть задачу</button></div>`;
  if (['ACCEPTED','CLOSED'].includes(assignment.status) && !reviewed) action += reviewForm(task.id);
  if (reviewed && ['ACCEPTED','CLOSED'].includes(assignment.status)) action += '<div class="result-box small" style="margin-top:14px">Спасибо — ваш отзыв уже опубликован.</div>';
  app.innerHTML = `<div class="page-shell">${backControl('Мои задачи', '/my-tasks')}<div class="work-head"><div><p class="eyebrow">Рабочая задача №${task.id}</p><h1>${esc(task.title)}</h1><p class="muted">${esc(assignment.customerName)} → ${esc(assignment.executorName)}</p><a class="text-link small" href="/tasks/${task.id}" data-link>Открыть карточку задачи</a></div>${statusBadge(assignment.status)}</div>
    ${workStatusTrack(assignment.status)}
    <div class="work-layout"><div class="detail-main">
      <section class="panel"><h2>Условия назначения</h2><div class="side-list" style="grid-template-columns:repeat(2,1fr);display:grid"><div><span>Исполнитель</span><strong>${esc(assignment.executorName)}</strong></div><div><span>Заказчик</span><strong>${esc(assignment.customerName)}</strong></div><div><span>Стоимость</span><strong>${money(assignment.proposedPrice)}</strong></div><div><span>Срок</span><strong>${date(assignment.proposedDeadline)}</strong></div></div></section>
      ${assignment.resultNote ? `<section class="panel"><h2>Результат работы</h2><div class="result-box">${esc(assignment.resultNote)}</div>${assignment.resultUrl ? `<p style="margin-top:15px"><a class="text-link" href="${esc(assignment.resultUrl)}" target="_blank" rel="noopener">Открыть приложенный результат ↗</a></p>` : ''}</section>` : ''}
      <section class="panel"><h2>Следующее действие</h2>${action}</section>
      ${reviews.length ? `<section class="panel"><h2>Отзывы</h2>${reviews.map((review) => `<article class="review"><span class="rating">${'★'.repeat(review.rating)}${'☆'.repeat(5-review.rating)}</span><p>${esc(review.text)}</p><small>${esc(review.author_name)}</small></article>`).join('')}</section>` : ''}
    </div><aside class="side-card"><h3>История задачи</h3><div class="timeline">${history.map((item) => `<div class="timeline-item"><strong>${esc(statusLabels[item.status] || item.status)}</strong>${item.note ? `<span>${esc(item.note)}</span>` : ''}<small>${esc(item.actor_name || 'Система')} · ${dateTime(item.created_at)}</small></div>`).join('')}</div></aside></div>
  </div>`;
}

function revisionModal(taskId) {
  state.modalReturnFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="revision-title"><div class="modal-head"><div><p class="eyebrow">Проверка результата</p><h2 id="revision-title">Что нужно доработать?</h2></div><button class="icon-btn" data-action="close-modal" aria-label="Закрыть">×</button></div><form id="revision-form" data-task-id="${taskId}"><div class="field"><label for="revisionNote">Конкретный комментарий</label><textarea id="revisionNote" name="revisionNote" minlength="10" maxlength="1000" required placeholder="Опишите, чего не хватает для принятия результата"></textarea></div><button class="btn btn-primary btn-block" type="submit">Вернуть в работу</button></form></div></div>`;
  requestAnimationFrame(() => modalRoot.querySelector('textarea')?.focus());
}

async function adminPage() {
  if (!state.bootstrap.user) return authGate('Панель доступна только модератору пилота.');
  if (!state.bootstrap.user.isAdmin) return accessDenied('Панель доступна только модератору пилота.');
  setTitle('Модерация');
  const data = await api('/api/admin/overview');
  const completedProfiles = data.users.filter((user) => user.completed_at).length;
  app.innerHTML = `<div class="page-shell"><div class="page-title-row"><div><p class="eyebrow">Операционная панель</p><h1>Пилот в цифрах</h1><p class="lead">Состояние воронки и ручная модерация первых публикаций.</p></div></div>
    <div class="admin-stats"><div class="metric"><strong>${data.users.length}</strong><span>пользователей</span></div><div class="metric"><strong>${completedProfiles}</strong><span>заполненных профилей</span></div><div class="metric"><strong>${data.funnel.assignments}</strong><span>назначений</span></div><div class="metric"><strong>${data.funnel.medianFirstRelevantHours === null ? '—' : `${data.funnel.medianFirstRelevantHours} ч`}</strong><span>медиана до подходящего кандидата</span></div></div>
    <section class="panel" style="margin-bottom:22px"><h2>Воронка реального пилота</h2><p class="muted small">Демо-аккаунты исключены. Подходящий кандидат — профиль с совпадением не ниже ${data.funnel.relevantMatchThreshold}% по указанным компетенциям.</p><div class="stats-inner" style="width:100%;grid-template-columns:repeat(5,1fr);overflow:auto"><div class="stat"><strong>${data.funnel.publishedTasks}</strong><span>опубликовано</span></div><div class="stat"><strong>${data.funnel.tasksWithApplications}</strong><span>получили отклики</span></div><div class="stat"><strong>${data.funnel.tasksWithRelevantCandidates}</strong><span>получили подходящих</span></div><div class="stat"><strong>${data.funnel.assignments}</strong><span>назначения</span></div><div class="stat"><strong>${data.funnel.completions}</strong><span>завершения</span></div></div></section>
    <section class="panel demo-metrics" style="margin-bottom:22px"><div><h2>Демонстрационный цикл</h2><p class="muted small">Отдельный контрольный набор: ${data.demoFunnel.publishedTasks} задач, ${data.demoFunnel.tasksWithApplications} с откликами, ${data.demoFunnel.assignments} назначение, ${data.demoFunnel.completions} завершение. Медиана до подходящего кандидата — ${data.demoFunnel.medianFirstRelevantHours ?? '—'} ч.</p></div><a class="btn btn-secondary btn-sm" href="/tasks/1/work" data-link>Показать завершённую работу</a></section>
    <section><div class="section-head" style="margin-bottom:15px"><div><h2 style="font-size:28px">Задачи</h2><p>Модератор публикует черновики и управляет видимостью. Рабочие статусы меняются только действиями участников.</p></div></div><div class="table-wrap"><table><thead><tr><th>Задача</th><th>Заказчик</th><th>Статус</th><th>Отклики</th><th>Модерация</th></tr></thead><tbody>${data.tasks.map((task) => `<tr><td><a class="text-link" href="/tasks/${task.id}" data-link>${esc(task.title)}</a></td><td>${esc(task.customer.name)}</td><td>${statusBadge(task.status)}</td><td>${task.applicationCount}</td><td>${['DRAFT','REJECTED'].includes(task.status) ? `<button class="btn btn-primary btn-sm" data-action="admin-publish" data-id="${task.id}">Опубликовать</button>` : `<button class="btn ${task.hidden ? 'btn-primary' : 'btn-secondary'} btn-sm" data-action="admin-toggle" data-id="${task.id}" data-hidden="${task.hidden}">${task.hidden ? 'Показать' : 'Скрыть'}</button>`}</td></tr>`).join('')}</tbody></table></div></section>
    <section style="margin-top:30px"><div class="section-head" style="margin-bottom:15px"><div><h2 style="font-size:28px">Пользователи</h2><p>Участники пилота и полнота профиля.</p></div></div><div class="table-wrap"><table><thead><tr><th>Имя</th><th>Email</th><th>Роль</th><th>Профиль</th></tr></thead><tbody>${data.users.map((user) => `<tr><td>${esc(user.name)}</td><td>${esc(user.email)}</td><td>${user.is_admin ? 'Модератор' : user.primary_role === 'CUSTOMER' ? 'Заказчик' : 'Исполнитель'}</td><td>${user.completed_at ? statusBadge('ACCEPTED') : '<span class="muted">Не заполнен</span>'}</td></tr>`).join('')}</tbody></table></div></section>
  </div>`;
}

function notFoundPage() {
  setTitle('Страница не найдена');
  app.innerHTML = `<div class="page-shell narrow">${empty('Страница не найдена', 'Возможно, ссылка устарела или адрес введён с ошибкой.', '<a class="btn btn-primary" href="/tasks" data-link>К задачам</a> <a class="btn btn-secondary" href="/" data-link>На главную</a>')}</div>`;
}

async function render() {
  const request = ++state.request;
  renderHeader();
  loading();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  try {
    if (path === '/') homePage();
    else if (path === '/tasks') await tasksPage();
    else if (path === '/tasks/create') taskCreatePage();
    else if (/^\/tasks\/\d+\/edit$/.test(path)) await taskEditPage(path.split('/')[2]);
    else if (/^\/tasks\/\d+$/.test(path)) await taskDetailPage(path.split('/')[2]);
    else if (/^\/tasks\/\d+\/work$/.test(path)) await workPage(path.split('/')[2]);
    else if (path === '/login') authPage('login');
    else if (path === '/register') authPage('register');
    else if (/^\/profile\/(me|\d+)$/.test(path)) await profilePage(path.split('/')[2]);
    else if (path === '/applications') await applicationsPage();
    else if (path === '/my-tasks') await myTasksPage();
    else if (path === '/admin') await adminPage();
    else notFoundPage();
    if (request !== state.request) return;
    app.focus({ preventScroll: true });
  } catch (error) {
    if (request !== state.request) return;
    app.innerHTML = `<div class="page-shell narrow">${empty('Не удалось открыть страницу', error.message, '<a class="btn btn-primary" href="/tasks" data-link>К задачам</a> <a class="btn btn-secondary" href="/my-tasks" data-link>Мои задачи</a>')}</div>`;
  }
}

async function refreshBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
  renderHeader();
}

function formData(form) {
  return Object.fromEntries(new FormData(form));
}

function busy(form, on) {
  form.querySelectorAll('button, input, select, textarea').forEach((element) => { element.disabled = on; });
  const submit = form.querySelector('button[type="submit"]');
  if (!submit) return;
  if (on) {
    submit.dataset.originalLabel = submit.textContent;
    submit.textContent = 'Подождите…';
  } else if (submit.dataset.originalLabel) {
    submit.textContent = submit.dataset.originalLabel;
    delete submit.dataset.originalLabel;
  }
}

function actionBusy(button) {
  button.dataset.originalLabel = button.textContent;
  button.textContent = 'Подождите…';
  button.disabled = true;
}

function resetAction(button) {
  button.disabled = false;
  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  }
}

function showFormError(form, message) {
  form.querySelector('.inline-error')?.remove();
  const error = document.createElement('div');
  error.className = 'inline-error';
  error.setAttribute('role', 'alert');
  error.tabIndex = -1;
  error.textContent = message;
  form.append(error);
  error.focus();
}

function showFieldError(field, message) {
  const container = field.closest('.field');
  if (!container) return showFormError(field.form, message);
  container.querySelector('.field-error')?.remove();
  const error = document.createElement('small');
  error.className = 'field-error';
  error.setAttribute('role', 'alert');
  error.textContent = message;
  container.append(error);
}

function updateDateValidity(input) {
  input.setCustomValidity('');
  let message = '';
  const iso = inputDateToIso(input.value);
  if (input.value && !iso) message = 'Введите дату полностью в формате ДД/ММ/ГГГГ.';
  if (iso) {
    const [year, month, day] = iso.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    const exists = parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
    if (!exists) message = 'Такой календарной даты не существует.';
    else if (input.dataset.minDate && iso < input.dataset.minDate) message = `Дата не может быть раньше ${isoToInputDate(input.dataset.minDate)}.`;
    else if (input.dataset.maxDate && iso > input.dataset.maxDate) message = `Дата не может быть позже ${isoToInputDate(input.dataset.maxDate)}.`;
  }
  input.setCustomValidity(message);
  return message;
}

function maskDateInput(value) {
  const digits = String(value).replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join('/');
}

function fieldValidationMessage(field) {
  const label = field.labels?.[0]?.textContent?.trim() || 'Поле';
  if (field.matches('[data-date-input]')) {
    const dateMessage = updateDateValidity(field);
    if (dateMessage) return `${label}: ${dateMessage}`;
  }
  if (field.validity.valueMissing) return `${label}: заполните поле.`;
  if (field.validity.tooShort) return `${label}: нужно минимум ${field.minLength} символов.`;
  if (field.validity.tooLong) return `${label}: допустимо не больше ${field.maxLength} символов.`;
  if (field.validity.rangeUnderflow) return `${label}: значение должно быть не меньше ${Number(field.min).toLocaleString('ru-RU')}.`;
  if (field.validity.rangeOverflow) return `${label}: значение должно быть не больше ${Number(field.max).toLocaleString('ru-RU')}.`;
  if (field.validity.stepMismatch) return `${label}: используйте шаг ${Number(field.step).toLocaleString('ru-RU')}.`;
  if (field.validity.typeMismatch) return `${label}: проверьте формат значения.`;
  if (field.validity.badInput) return `${label}: проверьте введённое значение.`;
  return `${label}: проверьте введённое значение.`;
}

function validateForm(form) {
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => field.removeAttribute('aria-invalid'));
  form.querySelectorAll('.field-error').forEach((error) => error.remove());
  form.querySelectorAll('[data-date-input]').forEach(updateDateValidity);
  const invalid = [...form.elements].find((field) => field.willValidate && !field.validity.valid);
  if (!invalid) return true;
  invalid.setAttribute('aria-invalid', 'true');
  showFieldError(invalid, fieldValidationMessage(invalid));
  invalid.focus();
  return false;
}

document.addEventListener('click', async (event) => {
  const link = event.target.closest('[data-link]');
  if (link && link.origin === location.origin) { event.preventDefault(); navigate(link.pathname + link.search); return; }
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  if (action === 'toggle-nav') {
    const nav = document.querySelector('#main-nav');
    const open = nav?.classList.toggle('open');
    actionEl.setAttribute('aria-expanded', String(Boolean(open)));
    actionEl.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    return;
  }
  if (action === 'close-modal') {
    if (event.target === actionEl || actionEl.tagName === 'BUTTON') closeModal();
    return;
  }
  try {
    if (action === 'logout') {
      actionBusy(actionEl);
      await api('/api/auth/logout', { method: 'POST', body: '{}' }); await refreshBootstrap(); navigate('/'); toast('Вы вышли из аккаунта');
    } else if (action === 'demo-login') {
      actionBusy(actionEl);
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: actionEl.dataset.email, password: 'demo1234' }) });
      await refreshBootstrap();
      const next = actionEl.dataset.next || new URLSearchParams(location.search).get('next');
      const safeNext = next?.startsWith('/') && !next.startsWith('//') ? next : null;
      const demoTarget = safeNext || (state.bootstrap.user.isAdmin ? '/admin' : state.bootstrap.user.primaryRole === 'EXECUTOR' ? '/tasks' : '/my-tasks');
      navigate(demoTarget); toast('Демо-режим включён');
    } else if (action === 'clear-filters') navigate('/tasks');
    else if (action === 'open-application') applicationModal(JSON.parse(actionEl.dataset.task));
    else if (action === 'publish-task') {
      actionBusy(actionEl); await api(`/api/tasks/${actionEl.dataset.id}/publish`, { method: 'POST', body: '{}' }); toast('Задача опубликована'); await refreshBootstrap(); render();
    } else if (action === 'select-executor') {
      if (!confirm('Назначить этого исполнителя? Остальные отклики будут отклонены.')) return;
      actionBusy(actionEl); const result = await api(`/api/applications/${actionEl.dataset.id}/select`, { method: 'POST', body: '{}' }); toast('Исполнитель выбран'); navigate(`/tasks/${result.taskId}/work`);
    } else if (action === 'task-tab') {
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab === actionEl));
      document.querySelectorAll('.tab').forEach((tab) => tab.setAttribute('aria-selected', String(tab === actionEl)));
      document.querySelectorAll('[id^="task-tab-"]').forEach((section) => { section.hidden = section.id !== `task-tab-${actionEl.dataset.tab}`; });
      history.replaceState({}, '', `/my-tasks?tab=${actionEl.dataset.tab}`);
    } else if (action === 'work-action') {
      if (['accept', 'close'].includes(actionEl.dataset.workAction)) {
        const question = actionEl.dataset.workAction === 'accept'
          ? 'Принять результат? После этого вернуть работу на доработку будет нельзя.'
          : 'Закрыть задачу? Она останется доступна в истории.';
        if (!confirm(question)) return;
      }
      actionBusy(actionEl); await api(`/api/tasks/${actionEl.dataset.id}/work/${actionEl.dataset.workAction}`, { method: 'POST', body: '{}' }); toast(actionEl.dataset.workAction === 'accept' ? 'Результат принят. Можно оставить отзыв и закрыть задачу' : actionEl.dataset.workAction === 'close' ? 'Задача завершена' : 'Задача переведена в работу'); await refreshBootstrap(); render();
    } else if (action === 'open-revision') revisionModal(actionEl.dataset.id);
    else if (action === 'admin-toggle') {
      if (actionEl.dataset.hidden !== 'true' && !confirm('Скрыть задачу из публичного каталога? Участники назначения сохранят доступ.')) return;
      actionBusy(actionEl); await api(`/api/admin/tasks/${actionEl.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ hidden: actionEl.dataset.hidden !== 'true' }) }); toast('Видимость обновлена'); render();
    } else if (action === 'admin-publish') {
      if (!confirm('Опубликовать задачу в общем каталоге?')) return;
      actionBusy(actionEl); await api(`/api/admin/tasks/${actionEl.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'PUBLISHED' }) }); toast('Задача опубликована'); render();
    }
  } catch (error) { resetAction(actionEl); toast(error.message, 'error'); }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;
  event.preventDefault();
  form.querySelector('.inline-error')?.remove();
  if (!validateForm(form)) return;
  const data = formData(form);
  busy(form, true);
  try {
    if (form.id === 'filters-form') {
      data.deadline = inputDateToIso(data.deadline);
      const params = new URLSearchParams(Object.entries(data).filter(([, value]) => value)); navigate(`/tasks${params.size ? `?${params}` : ''}`);
    } else if (form.id === 'login-form') {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) }); await refreshBootstrap();
      const next = new URLSearchParams(location.search).get('next');
      const defaultTarget = state.bootstrap.user.isAdmin ? '/admin' : state.bootstrap.user.primaryRole === 'EXECUTOR' ? '/tasks' : '/my-tasks';
      navigate(next?.startsWith('/') && !next.startsWith('//') ? next : defaultTarget); toast('Вы вошли');
    } else if (form.id === 'register-form') {
      await api('/api/auth/register', { method: 'POST', body: JSON.stringify(data) }); await refreshBootstrap();
      navigate(data.role === 'EXECUTOR' ? '/profile/me' : '/tasks/create'); toast('Аккаунт создан');
    } else if (form.id === 'task-form') {
      const payload = { ...data, deadline: inputDateToIso(data.deadline), skills: data.skills.split(',').map((item) => item.trim()).filter(Boolean), publish: new FormData(form).has('publish') };
      if (form.dataset.taskId) {
        const taskId = form.dataset.taskId;
        await api(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(payload) });
        if (payload.publish) await api(`/api/tasks/${taskId}/publish`, { method: 'POST', body: '{}' });
        await refreshBootstrap(); navigate(`/tasks/${taskId}`); toast(payload.publish ? 'Изменения сохранены, задача опубликована' : 'Изменения сохранены');
      } else {
        const result = await api('/api/tasks', { method: 'POST', body: JSON.stringify(payload) }); await refreshBootstrap(); navigate(`/tasks/${result.taskId}`); toast(result.status === 'PUBLISHED' ? 'Задача опубликована' : 'Черновик сохранён');
      }
    } else if (form.id === 'profile-form') {
      const payload = { ...data, skills: data.skills.split(',').map((item) => item.trim()).filter(Boolean) };
      await api('/api/profile/me', { method: 'PUT', body: JSON.stringify(payload) }); await refreshBootstrap(); toast('Профиль сохранён'); navigate('/tasks');
    } else if (form.id === 'application-form') {
      data.proposedDeadline = inputDateToIso(data.proposedDeadline);
      await api(`/api/tasks/${form.dataset.taskId}/applications`, { method: 'POST', body: JSON.stringify(data) }); modalRoot.innerHTML = ''; toast('Отклик отправлен. Заказчик увидит его среди кандидатов'); navigate('/my-tasks?tab=applied');
    } else if (form.id === 'result-form') {
      await api(`/api/tasks/${form.dataset.taskId}/work/submit`, { method: 'POST', body: JSON.stringify(data) }); toast('Результат отправлен заказчику'); render();
    } else if (form.id === 'revision-form') {
      await api(`/api/tasks/${form.dataset.taskId}/work/revise`, { method: 'POST', body: JSON.stringify(data) }); modalRoot.innerHTML = ''; toast('Задача возвращена в работу'); render();
    } else if (form.id === 'review-form') {
      await api(`/api/tasks/${form.dataset.taskId}/reviews`, { method: 'POST', body: JSON.stringify(data) }); toast('Отзыв опубликован'); render();
    }
  } catch (error) { toast(error.message, 'error'); showFormError(form, error.message); busy(form, false); }
});

document.addEventListener('input', (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
  field.removeAttribute('aria-invalid');
  field.closest('.field')?.querySelector('.field-error')?.remove();
  if (field instanceof HTMLInputElement && field.matches('[data-date-input]')) {
    field.value = maskDateInput(field.value);
    const message = updateDateValidity(field);
    if (field.value.length === 10 && message) {
      field.setAttribute('aria-invalid', 'true');
      showFieldError(field, fieldValidationMessage(field));
    }
  }
});

window.addEventListener('popstate', render);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (modalRoot.innerHTML) closeModal();
  const nav = document.querySelector('#main-nav.open');
  if (nav) {
    nav.classList.remove('open');
    const button = document.querySelector('[data-action="toggle-nav"]');
    button?.setAttribute('aria-expanded', 'false');
    button?.setAttribute('aria-label', 'Открыть меню');
    button?.focus();
  }
});

refreshBootstrap().then(render).catch((error) => {
  app.innerHTML = `<div class="page-shell narrow">${empty('Сервис не запустился', error.message)}</div>`;
});
