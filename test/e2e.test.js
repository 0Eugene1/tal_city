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
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    async raw(path) {
      return fetch(`${baseUrl}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
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
  assert.equal(smartTask.status, 'PUBLISHED');

  const smartDetail = await customer.request(`/api/tasks/${smartTask.id}`);
  assert.deepEqual(smartDetail.applications.map((item) => item.match.score), [100, 75, 25]);
  assert.deepEqual(smartDetail.attachments.map((item) => item.name), ['technical-brief.pdf', 'integration-checklist.doc']);
  assert.ok(smartDetail.attachments.every((item) => item.previewText && item.previewUrl));
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
  assert.equal(overview.demoFunnel.publishedTasks, 8);
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
  await customer.request('/api/profile/me', { method: 'PUT', body: {
    organizationName: 'Лаборатория городских сервисов', organizationRole: 'Руководитель проекта',
    location: 'Новосибирск', bio: 'Команда проверяет и запускает полезные цифровые сервисы для жителей города.',
    contact: `customer-${suffix}@test.city`, website: 'https://example.test/lab',
  }});
  await customer.request('/api/profile/me/submit-verification', { method: 'POST' });
  const moderator = client();
  await moderator.request('/api/auth/login', { method: 'POST', body: { email: 'admin@talent.city', password: 'demo1234' } });
  const customerId = Number(db.prepare(`SELECT id FROM users WHERE email=?`).get(`customer-${suffix}@test.city`).id);
  await moderator.request(`/api/admin/profiles/${customerId}`, { method: 'PATCH', body: { action: 'approve' } });
  const created = await customer.request('/api/tasks', { method: 'POST', body: {
    title: 'Проверить полный сценарий биржи',
    description: 'Нужно пройти рабочий цикл новой задачи и подтвердить корректность всех статусных переходов.',
    expectedResult: 'Автоматический отчёт об успешном сквозном тесте.',
    category: 'IT', skills: ['Node.js', 'Testing'], budget: 75000,
    deadline: futureDate(60), location: 'Новосибирск', format: 'REMOTE', publish: false,
  }});
  assert.equal(created.status, 'DRAFT');
  const submitted = await customer.request(`/api/tasks/${created.taskId}/publish`, { method: 'POST' });
  assert.equal(submitted.status, 'PENDING_MODERATION');
  await moderator.request(`/api/admin/tasks/${created.taskId}`, { method: 'PATCH', body: { status: 'PUBLISHED' } });

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
  for (const expected of ['task_created', 'task_submitted_for_moderation', 'task_approved', 'application_created', 'executor_selected', 'task_started', 'result_submitted', 'result_accepted', 'task_closed', 'review_created']) {
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
  await customer.request('/api/profile/me', { method: 'PUT', body: {
    organizationName: 'Команда серверной проверки', organizationRole: 'Владелец продукта', location: 'Новосибирск',
    bio: 'Команда проверяет серверные ограничения и безопасность пользовательских сценариев.',
    contact: `${suffix}-customer@test.city`, website: 'https://example.test/validation',
  }});
  await customer.request('/api/profile/me/submit-verification', { method: 'POST' });
  const moderator = client();
  await moderator.request('/api/auth/login', { method: 'POST', body: { email: 'admin@talent.city', password: 'demo1234' } });
  const validationCustomerId = Number(db.prepare('SELECT id FROM users WHERE email=?').get(`${suffix}-customer@test.city`).id);
  await moderator.request(`/api/admin/profiles/${validationCustomerId}`, { method: 'PATCH', body: { action: 'approve' } });
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
  await customer.request(`/api/tasks/${created.taskId}/publish`, { method: 'POST' });
  await moderator.request(`/api/admin/tasks/${created.taskId}`, { method: 'PATCH', body: { status: 'PUBLISHED' } });

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
  const customerProfile = await customer.request('/api/profile/me');
  assert.equal(customerProfile.role, 'CUSTOMER');
  await assert.rejects(customer.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: {
    message: 'Заказчик не должен иметь возможность откликаться на задачи как исполнитель.', proposedPrice: 48000, proposedDeadline: futureDate(20),
  }}), /только исполнителю/);

  const offer = { message: 'Проверю ограничения, автоматизирую сценарий и приложу понятный отчёт.', proposedPrice: 48000, proposedDeadline: futureDate(20) };
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: { ...offer, proposedPrice: 0 } }), /Стоимость/);
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: { ...offer, proposedDeadline: futureDate(-1) } }), /не раньше/);
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: { ...offer, proposedDeadline: futureDate(40) } }), /не позже/);
  const application = await executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: offer });
  await assert.rejects(executor.request(`/api/tasks/${created.taskId}/applications`, { method: 'POST', body: offer }), /уже откликнулись/);
  await assert.rejects(customer.request(`/api/tasks/${created.taskId}`, { method: 'PUT', body: { ...baseTask, deadline: futureDate(10) } }), /после публикации условия задачи менять нельзя/);

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

  const admin = moderator;
  await assert.rejects(admin.request('/api/tasks', { method: 'POST', body: baseTask }), /только заказчику/);
  await assert.rejects(admin.request(`/api/admin/tasks/${created.taskId}`, { method: 'PATCH', body: { status: 'ACCEPTED' } }), /не может менять рабочий статус/);
  const moderated = await customer.request('/api/tasks', { method: 'POST', body: {
    ...baseTask, title: 'Черновик для проверки модерации', publish: false,
  }});
  await assert.rejects(admin.request(`/api/admin/tasks/${moderated.taskId}`, { method: 'PATCH', body: { status: 'PUBLISHED' } }), /не может менять рабочий статус/);
  await customer.request(`/api/tasks/${moderated.taskId}/publish`, { method: 'POST' });
  await admin.request(`/api/admin/tasks/${moderated.taskId}`, { method: 'PATCH', body: { status: 'PUBLISHED' } });
  let moderatedView = await client().request('/api/tasks?q=Черновик%20для%20проверки');
  assert.ok(moderatedView.tasks.some((task) => task.id === moderated.taskId));
  await admin.request(`/api/admin/tasks/${moderated.taskId}`, { method: 'PATCH', body: { hidden: true } });
  moderatedView = await client().request('/api/tasks?q=Черновик%20для%20проверки');
  assert.ok(!moderatedView.tasks.some((task) => task.id === moderated.taskId));
  await admin.request(`/api/admin/tasks/${moderated.taskId}`, { method: 'PATCH', body: { hidden: false } });
  await assert.rejects(executor.request('/api/admin/overview'), /Доступно только модератору/);
});

test('доверие, премодерация, вложения, дедлайн и приватное обсуждение защищены API', async () => {
  const suffix = Date.now();
  const customer = client();
  const executor = client();
  const outsider = client();
  const admin = client();
  await customer.request('/api/auth/register', { method: 'POST', body: {
    name: 'Анна Заказчик', email: `trust-c-${suffix}@test.city`, password: 'testpass123', role: 'CUSTOMER',
  }});
  await customer.request('/api/profile/me', { method: 'PUT', body: {
    organizationName: 'Фонд городских решений', organizationRole: 'Продюсер проектов', location: 'Новосибирск',
    bio: 'Фонд запускает прикладные городские инициативы вместе с локальными командами.',
    contact: `trust-c-${suffix}@test.city`, website: 'https://example.test/fund',
  }});
  const draft = await customer.request('/api/tasks', { method: 'POST', body: {
    title: 'Подготовить открытый городской отчёт',
    description: 'Нужно собрать данные проекта и подготовить понятный интерактивный отчёт для жителей города.',
    expectedResult: 'Опубликованный отчёт, исходные данные и инструкция обновления.', category: 'IT', skills: ['Node.js'],
    budget: 80000, applicationDeadline: futureDate(10), deadline: futureDate(20), location: 'Новосибирск', format: 'REMOTE',
  }});
  await assert.rejects(customer.request(`/api/tasks/${draft.taskId}/publish`, { method: 'POST' }), /после подтверждения профиля/);
  await customer.request('/api/profile/me/submit-verification', { method: 'POST' });

  await executor.request('/api/auth/register', { method: 'POST', body: {
    name: 'Игорь Исполнитель', email: `trust-e-${suffix}@test.city`, password: 'testpass123', role: 'EXECUTOR',
  }});
  await assert.rejects(executor.request(`/api/admin/profiles/1`, { method: 'PATCH', body: { action: 'approve' } }), /только модератору/);
  await executor.request('/api/profile/me', { method: 'PUT', body: {
    specialization: 'Backend Developer', bio: 'Разрабатываю безопасные сервисы и автоматизирую проверку продуктовых сценариев.',
    skills: ['Node.js'], experience: 'Более четырёх лет создаю серверные приложения и интеграционные тесты.',
    portfolio: '', github: 'https://github.com/example', location: 'Новосибирск', workFormat: 'REMOTE',
    availability: 'Готов начать на следующей неделе', desiredRate: 1900,
  }});
  await assert.rejects(executor.request('/api/profile/me', { method: 'PUT', body: {
    specialization: 'Backend Developer', bio: 'Разрабатываю безопасные сервисы и автоматизирую проверку продуктовых сценариев.',
    skills: ['Node.js'], experience: 'Более четырёх лет создаю серверные приложения и интеграционные тесты.',
    github: 'javascript:alert(1)', location: 'Новосибирск', workFormat: 'REMOTE', availability: 'Готов начать', desiredRate: 1900,
  }}), /полную ссылку/);
  await assert.rejects(executor.request('/api/profile/me/resume', { method: 'POST', body: {
    name: 'resume.png', mimeType: 'image/png', data: Buffer.from('image').toString('base64'),
  }}), /Недопустимый тип файла/);

  await admin.request('/api/auth/login', { method: 'POST', body: { email: 'admin@talent.city', password: 'demo1234' } });
  const customerId = Number(db.prepare('SELECT id FROM users WHERE email=?').get(`trust-c-${suffix}@test.city`).id);
  await admin.request(`/api/admin/profiles/${customerId}`, { method: 'PATCH', body: { action: 'approve' } });

  await assert.rejects(customer.request('/api/tasks', { method: 'POST', body: {
    title: 'Некорректный дедлайн заявки', description: 'Проверяем обязательное ограничение последовательности дат для новой задачи.',
    expectedResult: 'Сервер отклоняет некорректную последовательность дат.', category: 'IT', skills: ['Node.js'], budget: 50000,
    applicationDeadline: futureDate(30), deadline: futureDate(20), location: 'Новосибирск', format: 'REMOTE',
  }}), /не позже/);
  await assert.rejects(customer.request(`/api/tasks/${draft.taskId}/attachments`, { method: 'POST', body: {
    name: 'payload.js', mimeType: 'text/javascript', data: Buffer.from('alert(1)').toString('base64'),
  }}), /Недопустимый тип файла/);
  await assert.rejects(customer.request(`/api/tasks/${draft.taskId}/attachments`, { method: 'POST', body: {
    name: 'oversize.pdf', mimeType: 'application/pdf', data: Buffer.alloc((10 * 1024 * 1024) + 1, 1).toString('base64'),
  }}), /превышает лимит 10 МБ/);
  const uploaded = await customer.request(`/api/tasks/${draft.taskId}/attachments`, { method: 'POST', body: {
    name: 'brief.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 demo').toString('base64'),
  }});
  const download = await customer.raw(uploaded.attachment.url);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/pdf/);
  assert.equal((await customer.raw('/api/attachments/999999999')).status, 404);

  await customer.request(`/api/tasks/${draft.taskId}/publish`, { method: 'POST' });
  const pendingCatalog = await executor.request('/api/tasks?q=открытый%20городской%20отчёт');
  assert.ok(!pendingCatalog.tasks.some((task) => task.id === draft.taskId));
  await assert.rejects(executor.request(`/api/tasks/${draft.taskId}/applications`, { method: 'POST', body: {
    message: 'Подготовлю архитектуру отчёта, сбор данных и воспроизводимую инструкцию обновления.', proposedPrice: 75000, proposedDeadline: futureDate(18),
  }}), /Задача не найдена/);
  await assert.rejects(admin.request(`/api/admin/tasks/${draft.taskId}`, { method: 'PATCH', body: { status: 'REJECTED' } }), /Причина отклонения/);
  await admin.request(`/api/admin/tasks/${draft.taskId}`, { method: 'PATCH', body: { status: 'PUBLISHED' } });

  const application = await executor.request(`/api/tasks/${draft.taskId}/applications`, { method: 'POST', body: {
    message: 'Подготовлю архитектуру отчёта, сбор данных и воспроизводимую инструкцию обновления.', proposedPrice: 75000, proposedDeadline: futureDate(18),
  }});
  await customer.request(`/api/applications/${application.applicationId}/comments`, { method: 'POST', body: { text: 'Какие данные потребуются на старте?' } });
  const discussion = await executor.request(`/api/applications/${application.applicationId}`);
  assert.equal(discussion.comments.length, 1);
  await outsider.request('/api/auth/register', { method: 'POST', body: {
    name: 'Посторонний пользователь', email: `outsider-${suffix}@test.city`, password: 'testpass123', role: 'EXECUTOR',
  }});
  await outsider.request('/api/profile/me', { method: 'PUT', body: {
    specialization: 'Тестировщик', bio: 'Проверяю разграничение доступа и пограничные состояния пользовательских сценариев.',
    skills: ['Testing'], experience: 'Пять лет тестирую веб-приложения и интеграционные API.', portfolio: '',
    location: 'Томск', workFormat: 'REMOTE', availability: 'Доступен', desiredRate: 1500,
  }});
  await outsider.request('/api/profile/me/submit-verification', { method: 'POST' });
  const outsiderId = Number(db.prepare('SELECT id FROM users WHERE email=?').get(`outsider-${suffix}@test.city`).id);
  await assert.rejects(admin.request(`/api/admin/profiles/${outsiderId}`, { method: 'PATCH', body: { action: 'reject' } }), /Причина отклонения/);
  await admin.request(`/api/admin/profiles/${outsiderId}`, { method: 'PATCH', body: { action: 'reject', reason: 'Добавьте ссылку на подтверждённый проект.' } });
  assert.equal((await outsider.request('/api/profile/me')).profile.verificationStatus, 'REJECTED');
  await assert.rejects(outsider.request(`/api/applications/${application.applicationId}`), /Нет доступа/);

  db.prepare('UPDATE tasks SET application_deadline=? WHERE id=?').run(futureDate(-1), draft.taskId);
  await assert.rejects(outsider.request(`/api/tasks/${draft.taskId}/applications`, { method: 'POST', body: {
    message: 'Новый отклик после срока не должен быть создан даже прямым вызовом API.', proposedPrice: 76000, proposedDeadline: futureDate(15),
  }}), /Приём заявок завершён/);
  const events = db.prepare('SELECT name FROM analytics_events WHERE task_id=?').all(draft.taskId).map((row) => row.name);
  for (const name of ['task_attachment_uploaded', 'task_submitted_for_moderation', 'task_approved', 'application_opened', 'application_comment_created', 'application_deadline_reached', 'application_blocked_after_deadline']) assert.ok(events.includes(name), name);
});

test('критичные клиентские маршруты и страницы ошибок доступны через SPA', async () => {
  for (const path of ['/', '/tasks', '/tasks/create', '/tasks/1', '/tasks/1/edit', '/profile/1', '/applications', '/applications/1', '/my-tasks', '/tasks/1/work', '/admin', '/does-not-exist']) {
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
  assert.match(clientScript, /user-chip user-chip--link/);
  assert.match(clientScript, /user-chip user-chip--static/);
  assert.match(clientScript, /href="\/profile\/me" data-link title="Открыть профиль заказчика"/);
  assert.doesNotMatch(clientScript, /const accountHref/);
  const styles = await (await fetch(`${baseUrl}/styles.css`)).text();
  assert.match(styles, /Keep responsive rules last/);
  assert.match(styles, /\.hero-inner \{ grid-template-columns: minmax\(0, 1fr\); gap: 44px; \}/);
  assert.match(styles, /html, body \{ max-width: 100%; overflow-x: hidden; \}/);
  await assert.rejects(client().request('/api/tasks/999999999'), /Задача не найдена/);
});
