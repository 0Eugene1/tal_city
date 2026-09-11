import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'talent-city-'));
process.env.TALENT_DB_PATH = join(tempDir, 'e2e.db');

const { createServer } = await import('../src/server.js');
const { db, toJson } = await import('../src/db.js');
const { calculateMatch } = await import('../src/matching.js');

let server;
let baseUrl;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return {
    async request(path, { method = 'GET', body } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const data = await response.json();
      if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
      return data;
    },
  };
}

function futureDate(days) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + days);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

test('matching детерминирован и объясним', () => {
  assert.deepEqual(toJson(null), []);
  assert.deepEqual(calculateMatch(['ROS2', 'Python', 'Computer Vision'], ['Python', 'ROS2', 'CV']), {
    score: 100,
    matchedSkills: ['ROS2', 'Python', 'Computer Vision'],
    missingSkills: [],
    explanation: 'Совпало 3 из 3 требуемых навыков.',
  });
  assert.deepEqual(calculateMatch([], ['Python']), {
    score: 0,
    matchedSkills: [],
    missingSkills: [],
    explanation: 'В задаче не указаны навыки — оцените опыт кандидата вручную.',
  });
});

test('демо-данные показывают подбор, доверие, завершённый цикл и продуктовую воронку', async () => {
  const customer = client();
  await customer.request('/api/auth/login', { method: 'POST', body: {
    email: 'customer@demo.city', password: 'demo1234',
  }});
  const emptyExecutorProfile = await client().request('/api/profile/2');
  assert.equal(emptyExecutorProfile.profile.id, 2);
  assert.deepEqual(emptyExecutorProfile.profile.skills, []);
  const myTasks = await customer.request('/api/my-tasks');
  assert.equal(myTasks.created.length, 2);
  assert.deepEqual(myTasks.assigned, []);
  assert.deepEqual(myTasks.applied, []);
  const smartTask = myTasks.created.find((task) => task.title === 'Автономная система контроля заполненности урн');
  assert.ok(smartTask);
  assert.equal(smartTask.status, 'REVIEWING');

  const smartDetail = await customer.request(`/api/tasks/${smartTask.id}`);
  assert.deepEqual(smartDetail.applications.map((item) => item.match.score), [100, 75, 25]);
  assert.deepEqual(smartDetail.applications[0].match.missingSkills, []);
  assert.ok(smartDetail.task.customer.publishedTasks >= 2);
  assert.equal(smartDetail.task.customer.completedTasks, 1);

  const closedTask = myTasks.created.find((task) => task.status === 'CLOSED');
  assert.ok(closedTask);
  const completedWork = await customer.request(`/api/tasks/${closedTask.id}/work`);
  assert.match(completedWork.assignment.resultNote, /Telegram-бот запущен/);
  assert.equal(completedWork.reviews.length, 2);

  const sergeyId = Number(db.prepare("SELECT id FROM users WHERE email='sergey@demo.city'").get().id);
  const publicProfile = await client().request(`/api/profile/${sergeyId}`);
  assert.equal(publicProfile.stats.completedTasks, 1);
  assert.equal(publicProfile.stats.reviewsCount, 1);
  assert.equal(publicProfile.stats.averageRating, 5);

  const noMatch = await customer.request('/api/tasks', { method: 'POST', body: {
    title: 'Задача без готового совпадения',
    description: 'Проверяем честное пустое состояние, когда в профилях нет нужной редкой компетенции.',
    expectedResult: 'Понятная подсказка заказчику вместо случайных кандидатов.',
    category: 'Другое', skills: ['Квантовая телепортация'], budget: 50000,
    deadline: futureDate(30), location: 'Новосибирск', format: 'REMOTE', publish: false,
  }});
  const noMatchDetail = await customer.request(`/api/tasks/${noMatch.taskId}`);
  assert.deepEqual(noMatchDetail.recommendations, []);

  const admin = client();
  await admin.request('/api/auth/login', { method: 'POST', body: { email: 'admin@talent.city', password: 'demo1234' } });
  const overview = await admin.request('/api/admin/overview');
  assert.equal(overview.funnel.publishedTasks, 0);
  assert.equal(overview.demoFunnel.publishedTasks, 10);
  assert.equal(overview.demoFunnel.tasksWithApplications, 2);
  assert.equal(overview.demoFunnel.tasksWithRelevantCandidates, 2);
  assert.equal(overview.demoFunnel.assignments, 1);
  assert.equal(overview.demoFunnel.completions, 1);
  assert.equal(overview.demoFunnel.relevantMatchThreshold, 50);
  assert.ok(overview.demoFunnel.medianFirstRelevantHours > 0);
});

test('полный цикл: Task → Application → Assignment → Result → Reviews', async () => {
  const customer = client();
  const executor = client();
  const suffix = Date.now();

  await customer.request('/api/auth/register', { method: 'POST', body: {
    name: 'Тестовый заказчик', email: `customer-${suffix}@test.city`, password: 'testpass123', role: 'CUSTOMER',
  }});
  const created = await customer.request('/api/tasks', { method: 'POST', body: {
    title: 'Проверить полный сценарий биржи',
    description: 'Нужно пройти рабочий цикл новой задачи и подтвердить корректность всех статусных переходов.',
    expectedResult: 'Автоматический отчёт об успешном сквозном тесте.',
    category: 'IT', skills: ['Node.js', 'Testing'], budget: 75000,
    deadline: futureDate(60), location: 'Новосибирск', format: 'REMOTE', publish: false,
  }});
  assert.equal(created.status, 'DRAFT');
  await customer.request(`/api/tasks/${created.taskId}/publish`, { method: 'POST' });

  await executor.request('/api/auth/register', { method: 'POST', body: {
    name: 'Тестовый исполнитель', email: `executor-${suffix}@test.city`, password: 'testpass123', role: 'EXECUTOR',
  }});
  await executor.request('/api/profile/me', { method: 'PUT', body: {
    bio: 'Разработчик, который автоматизирует проверку пользовательских сценариев.',
    skills: ['Node.js', 'Testing', 'SQLite'],
    experience: 'Пять лет создаю и тестирую веб-сервисы и продуктовые прототипы.',
    portfolio: 'Набор тестовых проектов', location: 'Новосибирск', workFormat: 'REMOTE',
    availability: 'Готов начать сегодня', desiredRate: 1800,
  }});
  const catalog = await executor.request('/api/tasks?q=полный%20сценарий');
  const task = catalog.tasks.find((item) => item.id === created.taskId);
  assert.equal(task.match.score, 100);

  const application = await executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: {
    message: 'Разобью сценарий на этапы, автоматизирую запросы и приложу воспроизводимый отчёт.',
    proposedPrice: 70000, proposedDeadline: futureDate(50),
  }});
  assert.ok(application.applicationId);

  const applications = await customer.request('/api/applications');
  const candidate = applications.applications.find((item) => item.id === application.applicationId);
  assert.equal(candidate.match.score, 100);
  const selected = await customer.request(`/api/applications/${application.applicationId}/select`, { method: 'POST' });
  assert.equal(selected.taskId, created.taskId);

  let work = await executor.request(`/api/tasks/${created.taskId}/work`);
  assert.equal(work.assignment.status, 'ASSIGNED');
  await executor.request(`/api/tasks/${created.taskId}/work/start`, { method: 'POST' });
  await executor.request(`/api/tasks/${created.taskId}/work/submit`, { method: 'POST', body: {
    resultNote: 'Сквозной сценарий автоматизирован, все проверки проходят последовательно.',
    resultUrl: 'https://example.test/report',
  }});

  work = await customer.request(`/api/tasks/${created.taskId}/work`);
  assert.equal(work.assignment.status, 'SUBMITTED');
  await customer.request(`/api/tasks/${created.taskId}/work/accept`, { method: 'POST' });
  await customer.request(`/api/tasks/${created.taskId}/reviews`, { method: 'POST', body: {
    rating: 5, text: 'Работа выполнена аккуратно, прозрачно и точно в согласованный срок.',
  }});
  await customer.request(`/api/tasks/${created.taskId}/work/close`, { method: 'POST' });

  await executor.request(`/api/tasks/${created.taskId}/reviews`, { method: 'POST', body: {
    rating: 5, text: 'Понятная постановка и быстрая проверка результата со стороны заказчика.',
  }});
  work = await executor.request(`/api/tasks/${created.taskId}/work`);
  assert.equal(work.assignment.status, 'CLOSED');
  assert.equal(work.reviews.length, 2);
  assert.deepEqual(work.history.slice(-5).map((item) => item.status), ['ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED', 'CLOSED']);

  const eventNames = db.prepare('SELECT name FROM analytics_events WHERE task_id = ?').all(created.taskId).map((row) => row.name);
  for (const expected of ['task_created', 'task_published', 'application_created', 'executor_selected', 'task_started', 'result_submitted', 'result_accepted', 'task_closed', 'review_created']) {
    assert.ok(eventNames.includes(expected), `нет события ${expected}`);
  }
});

test('даты, суммы, права и статусные переходы защищены сервером', async () => {
  const customer = client();
  const executor = client();
  const suffix = `validation-${Date.now()}`;
  await customer.request('/api/auth/register', { method: 'POST', body: {
    name: 'Заказчик валидации', email: `${suffix}-customer@test.city`, password: 'testpass123', role: 'CUSTOMER',
  }});
  await assert.rejects(client().request('/api/auth/login', { method: 'POST', body: {
    email: `${suffix}-customer@test.city`, password: 'wrong-password',
  }}), /Неверный email или пароль/);
  await assert.rejects(client().request('/api/auth/register', { method: 'POST', body: {
    name: 'Дубликат', email: `${suffix}-customer@test.city`, password: 'testpass123', role: 'CUSTOMER',
  }}), /уже существует/);

  const baseTask = {
    title: 'Проверка доменных ограничений',
    description: 'Задача нужна для проверки серверной валидации дат, сумм и переходов статусов.',
    expectedResult: 'Подтверждённые ограничения и понятные ошибки.',
    category: 'IT', skills: ['Node.js'], budget: 50000,
    deadline: futureDate(30), location: 'Новосибирск', format: 'REMOTE', publish: true,
  };

  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, deadline: '1111-01-01' } }), /дата должна быть не раньше/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, deadline: '0000-01-01' } }), /такой даты не существует/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, deadline: '9999-12-31' } }), /дата должна быть не позже/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, deadline: futureDate(-1) } }), /дата должна быть не раньше/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, deadline: '2026-02-31' } }), /такой даты не существует/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, deadline: futureDate(731) } }), /дата должна быть не позже/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, budget: 0 } }), /Бюджет/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, budget: '1e100' } }), /Бюджет/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, budget: 999999999999999 } }), /Бюджет/);
  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: { ...baseTask, skills: [] } }), /хотя бы один навык/);

  const created = await customer.request('/api/tasks', { method: 'POST', body: baseTask });

  await executor.request('/api/auth/register', { method: 'POST', body: {
    name: 'Исполнитель валидации', email: `${suffix}-executor@test.city`, password: 'testpass123', role: 'EXECUTOR',
  }});
  const profile = {
    bio: 'Проверяю продуктовые сценарии и серверные ограничения веб-приложений.',
    skills: ['Node.js'], experience: 'Опыт тестирования и автоматизации больше пяти лет.',
    portfolio: '', location: 'Новосибирск', workFormat: 'REMOTE', availability: 'Готов начать завтра', desiredRate: 1500,
  };
  await assert.rejects(executor.request('/api/profile/me', { method: 'PUT', body: { ...profile, desiredRate: 0 } }), /Ставка/);
  await executor.request('/api/profile/me', { method: 'PUT', body: profile });
  await assert.rejects(executor.request('/api/tasks', { method: 'POST', body: baseTask }), /только заказчику/);
  await assert.rejects(customer.request('/api/profile/me'), /только исполнителю/);
  await assert.rejects(customer.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: {
    message: 'Заказчик не должен иметь возможность откликаться на задачи как исполнитель.', proposedPrice: 48000, proposedDeadline: futureDate(20),
  }}), /только исполнителю/);

  const offer = { message: 'Проверю ограничения, автоматизирую сценарий и приложу понятный отчёт.', proposedPrice: 48000, proposedDeadline: futureDate(20) };
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: { ...offer, proposedPrice: 0 } }), /Стоимость/);
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: { ...offer, proposedDeadline: futureDate(-1) } }), /не раньше/);
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: { ...offer, proposedDeadline: futureDate(40) } }), /не позже/);
  const application = await executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: offer });
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: offer }), /уже откликнулись/);
  await assert.rejects(customer.request(`/api/tasks/${created.taskId}`, { method: 'PUT', body: { ...baseTask, deadline: futureDate(10) } }), /раньше уже предложенного срока/);

  const secondExecutor = client();
  await secondExecutor.request('/api/auth/register', { method: 'POST', body: {
    name: 'Второй исполнитель', email: `${suffix}-second@test.city`, password: 'testpass123', role: 'EXECUTOR',
  }});
  await secondExecutor.request('/api/profile/me', { method: 'PUT', body: { ...profile, bio: 'Второй кандидат с заполненным профилем для проверки отклонённого отклика.' } });
  await secondExecutor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: {
    ...offer, message: 'Предлагаю альтернативный подход, проверку ограничений и подробный отчёт.', proposedPrice: 49000,
  }});
  await customer.request(`/api/applications/${application.applicationId}/select`, { method: 'POST' });
  await assert.rejects(customer.request(`/api/applications/${application.applicationId}/select`, { method: 'POST' }), /уже выбран исполнитель/);
  const rejectedView = await secondExecutor.request(`/api/tasks/${created.taskId}`);
  assert.equal(rejectedView.myApplication.status, 'REJECTED');
  await assert.rejects(secondExecutor.request(`/api/tasks/${created.taskId}/work`), /Нет доступа к этой работе/);

  await assert.rejects(customer.request(`/api/tasks/${created.taskId}/work/start`, { method: 'POST' }), /Начать работу может исполнитель/);
  await assert.rejects(customer.request(`/api/tasks/${created.taskId}/work/accept`, { method: 'POST' }), /Статус задачи уже изменился/);
  await assert.rejects(customer.request(`/api/tasks/${created.taskId}/reviews`, { method: 'POST', body: { rating: 5, text: 'Отзыв оставлять пока рано.' } }), /после принятия результата/);
  await executor.request(`/api/tasks/${created.taskId}/work/start`, { method: 'POST' });
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/work/start`, { method: 'POST' }), /Статус задачи уже изменился/);
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/work/accept`, { method: 'POST' }), /Принять результат может заказчик/);
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/work/submit`, { method: 'POST', body: {
    resultNote: 'Результат готов, но ссылка использует запрещённую схему.', resultUrl: 'javascript:alert(1)',
  }}), /полную ссылку/);

  const admin = client();
  await admin.request('/api/auth/login', { method: 'POST', body: { email: 'admin@talent.city', password: 'demo1234' } });
  await assert.rejects(admin.request('/api/tasks', { method: 'POST', body: baseTask }), /только заказчику/);
  await assert.rejects(admin.request(`/api/admin/tasks/${created.taskId}`, { method: 'PATCH', body: { status: 'ACCEPTED' } }), /не может менять рабочий статус/);
  const moderated = await customer.request('/api/tasks', { method: 'POST', body: {
    ...baseTask, title: 'Черновик для проверки модерации', publish: false,
  }});
  await admin.request(`/api/admin/tasks/${moderated.taskId}`, { method: 'PATCH', body: { status: 'PUBLISHED' } });
  let moderatedView = await client().request('/api/tasks?q=Черновик%20для%20проверки');
  assert.ok(moderatedView.tasks.some((task) => task.id === moderated.taskId));
  await admin.request(`/api/admin/tasks/${moderated.taskId}`, { method: 'PATCH', body: { hidden: true } });
  moderatedView = await client().request('/api/tasks?q=Черновик%20для%20проверки');
  assert.ok(!moderatedView.tasks.some((task) => task.id === moderated.taskId));
  await admin.request(`/api/admin/tasks/${moderated.taskId}`, { method: 'PATCH', body: { hidden: false } });
  await assert.rejects(executor.request('/api/admin/overview'), /Доступно только модератору/);
});

test('критичные клиентские маршруты и страницы ошибок доступны через SPA', async () => {
  for (const path of ['/', '/tasks', '/tasks/create', '/tasks/1', '/tasks/1/edit', '/profile/1', '/applications', '/my-tasks', '/tasks/1/work', '/admin', '/does-not-exist']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/, path);
    assert.match(await response.text(), /id="app"/, path);
  }
  const clientScriptResponse = await fetch(`${baseUrl}/app.js`);
  assert.equal(clientScriptResponse.headers.get('cache-control'), 'no-cache');
  const clientScript = await clientScriptResponse.text();
  assert.match(clientScript, /id="task-form" novalidate/);
  assert.match(clientScript, /Дата не может быть позже/);
  assert.match(clientScript, /ДД\/ММ\/ГГГГ/);
  assert.match(clientScript, /step="1"/);
  assert.match(clientScript, /safeNext/);
  await assert.rejects(client().request('/api/tasks/999999999'), /Задача не найдена/);
});
