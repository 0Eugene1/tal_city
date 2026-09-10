import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'talent-city-'));
process.env.TALENT_DB_PATH = join(tempDir, 'e2e.db');

const { createServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');
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

test('matching детерминирован и объясним', () => {
  assert.deepEqual(calculateMatch(['ROS2', 'Python', 'Computer Vision'], ['Python', 'ROS2', 'CV']), {
    score: 100,
    matchedSkills: ['ROS2', 'Python', 'Computer Vision'],
    explanation: 'Совпадают навыки: ROS2, Python, Computer Vision',
  });
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
    deadline: '2026-12-20', location: 'Новосибирск', format: 'REMOTE', publish: false,
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
    proposedPrice: 70000, proposedDeadline: '2026-12-15',
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
