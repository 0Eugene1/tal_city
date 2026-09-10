import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, recordHistory, toJson, track } from './db.js';
import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hashToken,
  readCookies,
  sessionCookie,
  sessionExpiry,
  verifyPassword,
} from './auth.js';
import { calculateMatch } from './matching.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const CATEGORIES = ['IT', 'AI', 'Дизайн', 'Маркетинг', 'Инженерия', 'Робототехника', 'Исследования', 'Мероприятия', 'Контент', 'Другое'];
const FORMATS = ['REMOTE', 'HYBRID', 'ONSITE'];
const TASK_STATUSES = ['DRAFT', 'PUBLISHED', 'REVIEWING', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'CLOSED'];
const PUBLIC_TASK_STATUSES = ['PUBLISHED', 'REVIEWING'];

class ApiError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function json(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new ApiError(413, 'Слишком большой запрос');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new ApiError(400, 'Некорректный JSON'); }
}

function text(value, { required = false, min = 0, max = 5000, label = 'Поле' } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new ApiError(422, `${label}: заполните поле`);
  if (result.length < min) throw new ApiError(422, `${label}: минимум ${min} символа`);
  if (result.length > max) throw new ApiError(422, `${label}: максимум ${max} символов`);
  return result;
}

function positiveNumber(value, label, { allowZero = true } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new ApiError(422, `${label}: укажите целое положительное число`);
  }
  return number;
}

function list(value, label = 'Навыки') {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  const clean = [...new Set(values.map((item) => text(item, { max: 50 })).filter(Boolean))];
  if (clean.length > 12) throw new ApiError(422, `${label}: не больше 12 значений`);
  return clean;
}

function parseTask(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    expectedResult: row.expected_result,
    category: row.category,
    skills: toJson(row.skills),
    budget: Number(row.budget),
    deadline: row.deadline,
    location: row.location,
    format: row.format,
    customerId: Number(row.customer_id),
    assignedExecutorId: row.assigned_executor_id ? Number(row.assigned_executor_id) : null,
    status: row.status,
    hidden: Boolean(row.is_hidden),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    customer: row.customer_name ? { id: Number(row.customer_id), name: row.customer_name } : undefined,
    applicationCount: row.application_count === undefined ? undefined : Number(row.application_count),
  };
}

function parseProfile(row) {
  if (!row) return null;
  return {
    id: Number(row.user_id ?? row.id),
    name: row.name,
    bio: row.bio || '',
    skills: toJson(row.skills),
    experience: row.experience || '',
    portfolio: row.portfolio || '',
    location: row.location || '',
    workFormat: row.work_format || 'REMOTE',
    availability: row.availability || '',
    desiredRate: row.desired_rate === null || row.desired_rate === undefined ? null : Number(row.desired_rate),
    completed: Boolean(row.completed_at),
    completedAt: row.completed_at || null,
  };
}

function parseApplication(row, taskSkills = null) {
  const result = {
    id: Number(row.id),
    taskId: Number(row.task_id),
    executorId: Number(row.executor_id),
    message: row.message,
    proposedPrice: Number(row.proposed_price),
    proposedDeadline: row.proposed_deadline,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.executor_name) {
    result.executor = {
      id: Number(row.executor_id),
      name: row.executor_name,
      bio: row.bio || '',
      skills: toJson(row.profile_skills),
      experience: row.experience || '',
      location: row.profile_location || '',
      workFormat: row.work_format || '',
      desiredRate: row.desired_rate === null ? null : Number(row.desired_rate),
    };
    if (taskSkills) result.match = calculateMatch(taskSkills, result.executor.skills);
  }
  return result;
}

function sessionUser(req) {
  const token = readCookies(req.headers.cookie).talent_session;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.name, u.email, u.primary_role, u.is_admin,
      p.completed_at, p.skills, p.location, p.work_format
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), now());
  if (!row) return null;
  return {
    id: Number(row.id), name: row.name, email: row.email,
    primaryRole: row.primary_role, isAdmin: Boolean(row.is_admin),
    profileCompleted: Boolean(row.completed_at), skills: toJson(row.skills),
    location: row.location || '', workFormat: row.work_format || 'REMOTE',
  };
}

function requireUser(req) {
  const user = sessionUser(req);
  if (!user) throw new ApiError(401, 'Войдите, чтобы продолжить');
  return user;
}

function requireAdmin(req) {
  const user = requireUser(req);
  if (!user.isAdmin) throw new ApiError(403, 'Доступно только модератору');
  return user;
}

function setSession(res, userId, req) {
  const token = createSessionToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, sessionExpiry(), now());
  const secure = req.headers['x-forwarded-proto'] === 'https';
  return sessionCookie(token, secure);
}

function getTask(id) {
  return db.prepare(`SELECT t.*, u.name AS customer_name,
      (SELECT COUNT(*) FROM applications a WHERE a.task_id = t.id AND a.status != 'WITHDRAWN') AS application_count
    FROM tasks t JOIN users u ON u.id = t.customer_id WHERE t.id = ?`).get(id);
}

function ensureTaskVisible(row, user) {
  if (!row) throw new ApiError(404, 'Задача не найдена');
  const publicTask = PUBLIC_TASK_STATUSES.includes(row.status) && !row.is_hidden;
  const participant = user && (user.isAdmin || user.id === Number(row.customer_id) || user.id === Number(row.assigned_executor_id));
  if (!publicTask && !participant) throw new ApiError(404, 'Задача не найдена');
}

function validateTask(body) {
  const category = text(body.category, { required: true, max: 50, label: 'Категория' });
  const format = text(body.format, { required: true, max: 20, label: 'Формат' });
  if (!CATEGORIES.includes(category)) throw new ApiError(422, 'Выберите категорию из списка');
  if (!FORMATS.includes(format)) throw new ApiError(422, 'Выберите формат работы');
  const deadline = text(body.deadline, { required: true, max: 10, label: 'Срок' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new ApiError(422, 'Укажите дату завершения');
  return {
    title: text(body.title, { required: true, min: 5, max: 120, label: 'Название' }),
    description: text(body.description, { required: true, min: 30, max: 5000, label: 'Описание' }),
    expectedResult: text(body.expectedResult, { required: true, min: 10, max: 1000, label: 'Ожидаемый результат' }),
    category,
    skills: list(body.skills),
    budget: positiveNumber(body.budget, 'Бюджет'),
    deadline,
    location: text(body.location, { required: true, max: 100, label: 'Локация' }),
    format,
  };
}

function assignmentForTask(taskId) {
  return db.prepare(`SELECT a.*, c.name AS customer_name, e.name AS executor_name,
      ap.proposed_price, ap.proposed_deadline
    FROM assignments a
    JOIN users c ON c.id = a.customer_id
    JOIN users e ON e.id = a.executor_id
    JOIN applications ap ON ap.id = a.application_id
    WHERE a.task_id = ?`).get(taskId);
}

function requireAssignmentAccess(req, taskId) {
  const user = requireUser(req);
  const assignment = assignmentForTask(taskId);
  if (!assignment) throw new ApiError(404, 'Назначение не найдено');
  if (!user.isAdmin && user.id !== Number(assignment.customer_id) && user.id !== Number(assignment.executor_id)) {
    throw new ApiError(403, 'Нет доступа к этой работе');
  }
  return { user, assignment };
}

function transition({ taskId, actorId, from, to, assignmentFields = {}, event, note = '' }) {
  const assignment = assignmentForTask(taskId);
  if (!assignment || !from.includes(assignment.status)) throw new ApiError(409, 'Статус задачи уже изменился. Обновите страницу.');
  const timestamp = now();
  const fieldNames = Object.keys(assignmentFields);
  const setFields = ['status = ?', 'updated_at = ?', ...fieldNames.map((name) => `${name} = ?`)];
  const values = [to, timestamp, ...fieldNames.map((name) => assignmentFields[name]), assignment.id];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE assignments SET ${setFields.join(', ')} WHERE id = ?`).run(...values);
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(to, timestamp, taskId);
    recordHistory(taskId, actorId, to, note);
    if (event) track(event, { userId: actorId, taskId });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function api(req, res, url) {
  const method = req.method;
  const path = url.pathname;

  if (method === 'GET' && path === '/api/bootstrap') {
    const user = sessionUser(req);
    const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM tasks WHERE status IN ('PUBLISHED','REVIEWING') AND is_hidden = 0) AS tasks,
      (SELECT COUNT(*) FROM profiles WHERE completed_at IS NOT NULL) AS executors,
      (SELECT COUNT(*) FROM assignments) AS assignments`).get();
    return json(res, 200, { user, categories: CATEGORIES, formats: FORMATS, stats });
  }

  if (method === 'POST' && path === '/api/auth/register') {
    const body = await readJson(req);
    const name = text(body.name, { required: true, min: 2, max: 80, label: 'Имя' });
    const email = text(body.email, { required: true, max: 160, label: 'Email' }).toLowerCase();
    const password = text(body.password, { required: true, min: 8, max: 100, label: 'Пароль' });
    const role = body.role === 'CUSTOMER' ? 'CUSTOMER' : body.role === 'EXECUTOR' ? 'EXECUTOR' : null;
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError(422, 'Введите корректный email');
    if (!role) throw new ApiError(422, 'Выберите роль');
    try {
      const createdAt = now();
      const result = db.prepare(`INSERT INTO users (name, email, password_hash, primary_role, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(name, email, hashPassword(password), role, createdAt);
      const id = Number(result.lastInsertRowid);
      db.prepare(`INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)`).run(id, createdAt);
      track('user_registered', { userId: id, metadata: { role } });
      return json(res, 201, { ok: true, userId: id }, { 'Set-Cookie': setSession(res, id, req) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new ApiError(409, 'Пользователь с таким email уже существует');
      throw error;
    }
  }

  if (method === 'POST' && path === '/api/auth/login') {
    const body = await readJson(req);
    const email = text(body.email, { required: true, max: 160, label: 'Email' }).toLowerCase();
    const password = text(body.password, { required: true, max: 100, label: 'Пароль' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) throw new ApiError(401, 'Неверный email или пароль');
    return json(res, 200, { ok: true }, { 'Set-Cookie': setSession(res, Number(user.id), req) });
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    const token = readCookies(req.headers.cookie).talent_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req.headers['x-forwarded-proto'] === 'https') });
  }

  if (method === 'GET' && path === '/api/profile/me') {
    const user = requireUser(req);
    const row = db.prepare(`SELECT u.name, p.* FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`).get(user.id);
    return json(res, 200, { profile: parseProfile(row) });
  }

  if (method === 'PUT' && path === '/api/profile/me') {
    const user = requireUser(req);
    const body = await readJson(req);
    const profile = {
      bio: text(body.bio, { required: true, min: 20, max: 1000, label: 'О себе' }),
      skills: list(body.skills),
      experience: text(body.experience, { required: true, min: 20, max: 2000, label: 'Опыт' }),
      portfolio: text(body.portfolio, { max: 500, label: 'Портфолио' }),
      location: text(body.location, { required: true, max: 100, label: 'Локация' }),
      workFormat: FORMATS.includes(body.workFormat) ? body.workFormat : null,
      availability: text(body.availability, { required: true, max: 200, label: 'Доступность' }),
      desiredRate: body.desiredRate === '' || body.desiredRate === null ? null : positiveNumber(body.desiredRate, 'Ставка'),
    };
    if (!profile.skills.length) throw new ApiError(422, 'Добавьте хотя бы один навык');
    if (!profile.workFormat) throw new ApiError(422, 'Выберите формат работы');
    const existed = db.prepare('SELECT completed_at FROM profiles WHERE user_id = ?').get(user.id);
    const timestamp = now();
    db.prepare(`INSERT INTO profiles
      (user_id, bio, skills, experience, portfolio, location, work_format, availability, desired_rate, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET bio=excluded.bio, skills=excluded.skills, experience=excluded.experience,
      portfolio=excluded.portfolio, location=excluded.location, work_format=excluded.work_format,
      availability=excluded.availability, desired_rate=excluded.desired_rate,
      completed_at=COALESCE(profiles.completed_at, excluded.completed_at), updated_at=excluded.updated_at`)
      .run(user.id, profile.bio, JSON.stringify(profile.skills), profile.experience, profile.portfolio,
        profile.location, profile.workFormat, profile.availability, profile.desiredRate, timestamp, timestamp);
    if (!existed?.completed_at) track('profile_completed', { userId: user.id });
    return json(res, 200, { ok: true });
  }

  let match = path.match(/^\/api\/profile\/(\d+)$/);
  if (method === 'GET' && match) {
    const row = db.prepare(`SELECT u.name, p.* FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`).get(Number(match[1]));
    if (!row) throw new ApiError(404, 'Профиль не найден');
    const reviews = db.prepare(`SELECT r.rating, r.text, r.created_at, u.name AS author_name, t.title AS task_title
      FROM reviews r JOIN users u ON u.id=r.author_id JOIN tasks t ON t.id=r.task_id
      WHERE r.recipient_id=? ORDER BY r.created_at DESC`).all(Number(match[1]));
    return json(res, 200, { profile: parseProfile(row), reviews });
  }

  if (method === 'GET' && path === '/api/tasks') {
    const user = sessionUser(req);
    const where = [`t.status IN ('PUBLISHED','REVIEWING')`, 't.is_hidden = 0'];
    const params = [];
    if (url.searchParams.get('q')) {
      where.push('(t.title LIKE ? OR t.description LIKE ? OR t.skills LIKE ?)');
      const q = `%${url.searchParams.get('q').slice(0, 80)}%`; params.push(q, q, q);
    }
    if (url.searchParams.get('category')) { where.push('t.category = ?'); params.push(url.searchParams.get('category')); }
    if (url.searchParams.get('skill')) { where.push('t.skills LIKE ?'); params.push(`%${url.searchParams.get('skill').slice(0, 50)}%`); }
    if (url.searchParams.get('format')) { where.push('t.format = ?'); params.push(url.searchParams.get('format')); }
    if (url.searchParams.get('budgetMin')) { where.push('t.budget >= ?'); params.push(Number(url.searchParams.get('budgetMin')) || 0); }
    if (url.searchParams.get('budgetMax')) { where.push('t.budget <= ?'); params.push(Number(url.searchParams.get('budgetMax')) || 999999999); }
    if (url.searchParams.get('deadline')) { where.push('t.deadline <= ?'); params.push(url.searchParams.get('deadline')); }
    const rows = db.prepare(`SELECT t.*, u.name AS customer_name,
      (SELECT COUNT(*) FROM applications a WHERE a.task_id=t.id AND a.status!='WITHDRAWN') AS application_count
      FROM tasks t JOIN users u ON u.id=t.customer_id WHERE ${where.join(' AND ')} ORDER BY t.published_at DESC`).all(...params);
    const tasks = rows.map((row) => {
      const task = parseTask(row);
      if (user?.profileCompleted) task.match = calculateMatch(task.skills, user.skills);
      return task;
    });
    return json(res, 200, { tasks });
  }

  if (method === 'POST' && path === '/api/tasks') {
    const user = requireUser(req);
    const body = await readJson(req);
    const task = validateTask(body);
    const status = body.publish ? 'PUBLISHED' : 'DRAFT';
    const timestamp = now();
    const result = db.prepare(`INSERT INTO tasks
      (title, description, expected_result, category, skills, budget, deadline, location, format, customer_id, status, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.title, task.description, task.expectedResult, task.category, JSON.stringify(task.skills), task.budget,
        task.deadline, task.location, task.format, user.id, status, timestamp, timestamp, status === 'PUBLISHED' ? timestamp : null);
    const taskId = Number(result.lastInsertRowid);
    recordHistory(taskId, user.id, status, status === 'PUBLISHED' ? 'Задача опубликована' : 'Создан черновик');
    track('task_created', { userId: user.id, taskId });
    if (status === 'PUBLISHED') track('task_published', { userId: user.id, taskId });
    return json(res, 201, { taskId, status });
  }

  match = path.match(/^\/api\/tasks\/(\d+)$/);
  if (method === 'GET' && match) {
    const taskId = Number(match[1]);
    const user = sessionUser(req);
    const row = getTask(taskId);
    ensureTaskVisible(row, user);
    const task = parseTask(row);
    if (user?.profileCompleted) task.match = calculateMatch(task.skills, user.skills);
    if (!user || (user.id !== task.customerId && !user.isAdmin)) track('task_viewed', { userId: user?.id, taskId });
    const response = { task };
    const isOwner = user && (user.id === task.customerId || user.isAdmin);
    if (isOwner) {
      const appRows = db.prepare(`SELECT a.*, u.name AS executor_name, p.bio, p.skills AS profile_skills,
        p.experience, p.location AS profile_location, p.work_format, p.desired_rate
        FROM applications a JOIN users u ON u.id=a.executor_id LEFT JOIN profiles p ON p.user_id=u.id
        WHERE a.task_id=? ORDER BY a.created_at DESC`).all(taskId);
      response.applications = appRows.map((app) => parseApplication(app, task.skills)).sort((a, b) => b.match.score - a.match.score);
      const profileRows = db.prepare(`SELECT u.name, p.* FROM profiles p JOIN users u ON u.id=p.user_id
        WHERE p.completed_at IS NOT NULL AND p.user_id != ?`).all(task.customerId);
      response.recommendations = profileRows.map((profileRow) => {
        const profile = parseProfile(profileRow);
        return { profile, match: calculateMatch(task.skills, profile.skills) };
      }).sort((a, b) => b.match.score - a.match.score).slice(0, 5);
    }
    return json(res, 200, response);
  }

  if (method === 'PUT' && match) {
    const taskId = Number(match[1]);
    const user = requireUser(req);
    const row = getTask(taskId);
    if (!row) throw new ApiError(404, 'Задача не найдена');
    if (!user.isAdmin && user.id !== Number(row.customer_id)) throw new ApiError(403, 'Редактировать может только заказчик');
    if (!['DRAFT', 'PUBLISHED', 'REVIEWING'].includes(row.status)) throw new ApiError(409, 'Назначенную задачу уже нельзя редактировать');
    const task = validateTask(await readJson(req));
    db.prepare(`UPDATE tasks SET title=?,description=?,expected_result=?,category=?,skills=?,budget=?,deadline=?,location=?,format=?,updated_at=? WHERE id=?`)
      .run(task.title, task.description, task.expectedResult, task.category, JSON.stringify(task.skills), task.budget,
        task.deadline, task.location, task.format, now(), taskId);
    return json(res, 200, { ok: true });
  }

  match = path.match(/^\/api\/tasks\/(\d+)\/publish$/);
  if (method === 'POST' && match) {
    const taskId = Number(match[1]);
    const user = requireUser(req);
    const row = getTask(taskId);
    if (!row) throw new ApiError(404, 'Задача не найдена');
    if (!user.isAdmin && user.id !== Number(row.customer_id)) throw new ApiError(403, 'Публиковать может только заказчик');
    if (row.status !== 'DRAFT') throw new ApiError(409, 'Задача уже опубликована');
    const timestamp = now();
    db.prepare(`UPDATE tasks SET status='PUBLISHED', published_at=?, updated_at=? WHERE id=?`).run(timestamp, timestamp, taskId);
    recordHistory(taskId, user.id, 'PUBLISHED', 'Задача опубликована');
    track('task_published', { userId: user.id, taskId });
    return json(res, 200, { ok: true });
  }

  match = path.match(/^\/api\/tasks\/(\d+)\/applications$/);
  if (method === 'POST' && match) {
    const taskId = Number(match[1]);
    const user = requireUser(req);
    const task = getTask(taskId);
    ensureTaskVisible(task, user);
    if (!user.profileCompleted) throw new ApiError(409, 'Сначала заполните профиль исполнителя');
    if (user.id === Number(task.customer_id)) throw new ApiError(409, 'Нельзя откликнуться на собственную задачу');
    if (!PUBLIC_TASK_STATUSES.includes(task.status)) throw new ApiError(409, 'Задача больше не принимает отклики');
    const body = await readJson(req);
    const message = text(body.message, { required: true, min: 20, max: 1500, label: 'Сообщение' });
    const price = positiveNumber(body.proposedPrice, 'Стоимость');
    const deadline = text(body.proposedDeadline, { required: true, max: 10, label: 'Срок' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new ApiError(422, 'Укажите предложенный срок');
    try {
      const result = db.prepare(`INSERT INTO applications
        (task_id, executor_id, message, proposed_price, proposed_deadline, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'SUBMITTED', ?)`)
        .run(taskId, user.id, message, price, deadline, now());
      if (task.status === 'PUBLISHED') {
        db.prepare(`UPDATE tasks SET status='REVIEWING', updated_at=? WHERE id=?`).run(now(), taskId);
        recordHistory(taskId, user.id, 'REVIEWING', 'Получен первый отклик');
      }
      track('application_created', { userId: user.id, taskId, metadata: { applicationId: Number(result.lastInsertRowid) } });
      return json(res, 201, { applicationId: Number(result.lastInsertRowid) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new ApiError(409, 'Вы уже откликнулись на эту задачу');
      throw error;
    }
  }

  if (method === 'GET' && path === '/api/applications') {
    const user = requireUser(req);
    const rows = db.prepare(`SELECT a.*, t.title AS task_title, t.skills AS task_skills,
      u.name AS executor_name, p.bio, p.skills AS profile_skills, p.experience,
      p.location AS profile_location, p.work_format, p.desired_rate
      FROM applications a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=a.executor_id
      LEFT JOIN profiles p ON p.user_id=u.id WHERE t.customer_id=? ORDER BY a.created_at DESC`).all(user.id);
    for (const row of rows) track('application_viewed', { userId: user.id, taskId: Number(row.task_id), metadata: { applicationId: Number(row.id) } });
    return json(res, 200, { applications: rows.map((row) => ({ ...parseApplication(row, toJson(row.task_skills)), taskTitle: row.task_title })) });
  }

  match = path.match(/^\/api\/applications\/(\d+)\/select$/);
  if (method === 'POST' && match) {
    const user = requireUser(req);
    const applicationId = Number(match[1]);
    const app = db.prepare(`SELECT a.*, t.customer_id, t.status AS task_status FROM applications a JOIN tasks t ON t.id=a.task_id WHERE a.id=?`).get(applicationId);
    if (!app) throw new ApiError(404, 'Отклик не найден');
    if (!user.isAdmin && user.id !== Number(app.customer_id)) throw new ApiError(403, 'Исполнителя выбирает заказчик');
    if (!PUBLIC_TASK_STATUSES.includes(app.task_status)) throw new ApiError(409, 'Для задачи уже выбран исполнитель');
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE applications SET status=CASE WHEN id=? THEN 'ACCEPTED' ELSE 'REJECTED' END WHERE task_id=? AND status!='WITHDRAWN'`)
        .run(applicationId, app.task_id);
      db.prepare(`UPDATE tasks SET status='ASSIGNED', assigned_executor_id=?, updated_at=? WHERE id=?`)
        .run(app.executor_id, timestamp, app.task_id);
      db.prepare(`INSERT INTO assignments (task_id, application_id, customer_id, executor_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ASSIGNED', ?, ?)`)
        .run(app.task_id, applicationId, app.customer_id, app.executor_id, timestamp, timestamp);
      recordHistory(Number(app.task_id), user.id, 'ASSIGNED', 'Исполнитель выбран');
      track('executor_selected', { userId: user.id, taskId: Number(app.task_id), metadata: { executorId: Number(app.executor_id) } });
      db.exec('COMMIT');
      return json(res, 200, { ok: true, taskId: Number(app.task_id) });
    } catch (error) {
      db.exec('ROLLBACK'); throw error;
    }
  }

  if (method === 'GET' && path === '/api/my-tasks') {
    const user = requireUser(req);
    const created = db.prepare(`SELECT t.*, u.name AS customer_name,
      (SELECT COUNT(*) FROM applications a WHERE a.task_id=t.id AND a.status!='WITHDRAWN') AS application_count
      FROM tasks t JOIN users u ON u.id=t.customer_id WHERE t.customer_id=? ORDER BY t.updated_at DESC`).all(user.id).map(parseTask);
    const applied = db.prepare(`SELECT t.*, u.name AS customer_name, a.status AS my_application_status,
      (SELECT COUNT(*) FROM applications x WHERE x.task_id=t.id AND x.status!='WITHDRAWN') AS application_count
      FROM applications a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=t.customer_id
      WHERE a.executor_id=? ORDER BY a.created_at DESC`).all(user.id).map((row) => ({ ...parseTask(row), myApplicationStatus: row.my_application_status }));
    const assigned = db.prepare(`SELECT t.*, u.name AS customer_name,
      (SELECT COUNT(*) FROM applications x WHERE x.task_id=t.id AND x.status!='WITHDRAWN') AS application_count
      FROM assignments a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=t.customer_id
      WHERE a.executor_id=? ORDER BY a.updated_at DESC`).all(user.id).map(parseTask);
    return json(res, 200, { created, applied, assigned });
  }

  match = path.match(/^\/api\/tasks\/(\d+)\/work$/);
  if (method === 'GET' && match) {
    const taskId = Number(match[1]);
    const { user, assignment } = requireAssignmentAccess(req, taskId);
    const task = parseTask(getTask(taskId));
    const history = db.prepare(`SELECT h.status, h.note, h.created_at, u.name AS actor_name
      FROM task_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.task_id=? ORDER BY h.id`).all(taskId);
    const reviews = db.prepare(`SELECT r.*, u.name AS author_name FROM reviews r JOIN users u ON u.id=r.author_id WHERE r.task_id=? ORDER BY r.id`).all(taskId);
    return json(res, 200, { task, assignment: {
      id: Number(assignment.id), taskId, customerId: Number(assignment.customer_id), executorId: Number(assignment.executor_id),
      customerName: assignment.customer_name, executorName: assignment.executor_name, status: assignment.status,
      proposedPrice: Number(assignment.proposed_price), proposedDeadline: assignment.proposed_deadline,
      resultNote: assignment.result_note, resultUrl: assignment.result_url, revisionNote: assignment.revision_note,
    }, history, reviews, viewerId: user.id });
  }

  match = path.match(/^\/api\/tasks\/(\d+)\/work\/(start|submit|accept|revise|close)$/);
  if (method === 'POST' && match) {
    const taskId = Number(match[1]);
    const action = match[2];
    const { user, assignment } = requireAssignmentAccess(req, taskId);
    const body = await readJson(req);
    if (action === 'start') {
      if (user.id !== Number(assignment.executor_id)) throw new ApiError(403, 'Начать работу может исполнитель');
      transition({ taskId, actorId: user.id, from: ['ASSIGNED'], to: 'IN_PROGRESS', event: 'task_started', note: 'Исполнитель начал работу' });
    } else if (action === 'submit') {
      if (user.id !== Number(assignment.executor_id)) throw new ApiError(403, 'Отправить результат может исполнитель');
      const resultNote = text(body.resultNote, { required: true, min: 20, max: 3000, label: 'Описание результата' });
      const resultUrl = text(body.resultUrl, { max: 500, label: 'Ссылка на результат' });
      transition({ taskId, actorId: user.id, from: ['IN_PROGRESS'], to: 'SUBMITTED', assignmentFields: { result_note: resultNote, result_url: resultUrl, revision_note: '' }, event: 'result_submitted', note: 'Результат отправлен заказчику' });
    } else if (action === 'accept') {
      if (user.id !== Number(assignment.customer_id)) throw new ApiError(403, 'Принять результат может заказчик');
      transition({ taskId, actorId: user.id, from: ['SUBMITTED'], to: 'ACCEPTED', event: 'result_accepted', note: 'Результат принят' });
    } else if (action === 'revise') {
      if (user.id !== Number(assignment.customer_id)) throw new ApiError(403, 'Вернуть результат может заказчик');
      const revisionNote = text(body.revisionNote, { required: true, min: 10, max: 1000, label: 'Комментарий' });
      transition({ taskId, actorId: user.id, from: ['SUBMITTED'], to: 'IN_PROGRESS', assignmentFields: { revision_note: revisionNote }, note: `Возвращено на доработку: ${revisionNote}` });
    } else if (action === 'close') {
      if (user.id !== Number(assignment.customer_id)) throw new ApiError(403, 'Закрыть задачу может заказчик');
      transition({ taskId, actorId: user.id, from: ['ACCEPTED'], to: 'CLOSED', event: 'task_closed', note: 'Задача закрыта' });
    }
    return json(res, 200, { ok: true });
  }

  match = path.match(/^\/api\/tasks\/(\d+)\/reviews$/);
  if (method === 'POST' && match) {
    const taskId = Number(match[1]);
    const { user, assignment } = requireAssignmentAccess(req, taskId);
    if (!['ACCEPTED', 'CLOSED'].includes(assignment.status)) throw new ApiError(409, 'Отзыв доступен после принятия результата');
    const body = await readJson(req);
    const rating = positiveNumber(body.rating, 'Оценка', { allowZero: false });
    if (rating > 5) throw new ApiError(422, 'Оценка должна быть от 1 до 5');
    const reviewText = text(body.text, { required: true, min: 10, max: 1000, label: 'Отзыв' });
    const recipientId = user.id === Number(assignment.customer_id) ? Number(assignment.executor_id) : Number(assignment.customer_id);
    try {
      db.prepare(`INSERT INTO reviews (task_id, author_id, recipient_id, rating, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(taskId, user.id, recipientId, rating, reviewText, now());
      track('review_created', { userId: user.id, taskId, metadata: { recipientId, rating } });
      return json(res, 201, { ok: true });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new ApiError(409, 'Вы уже оставили отзыв по этой задаче');
      throw error;
    }
  }

  if (method === 'GET' && path === '/api/admin/overview') {
    requireAdmin(req);
    const users = db.prepare(`SELECT u.id,u.name,u.email,u.primary_role,u.is_admin,u.created_at,p.completed_at
      FROM users u LEFT JOIN profiles p ON p.user_id=u.id ORDER BY u.created_at DESC`).all();
    const tasks = db.prepare(`SELECT t.*,u.name AS customer_name,
      (SELECT COUNT(*) FROM applications a WHERE a.task_id=t.id) AS application_count
      FROM tasks t JOIN users u ON u.id=t.customer_id ORDER BY t.updated_at DESC`).all().map(parseTask);
    const applications = db.prepare('SELECT status, COUNT(*) AS count FROM applications GROUP BY status').all();
    const events = db.prepare('SELECT name, COUNT(*) AS count FROM analytics_events GROUP BY name ORDER BY count DESC').all();
    const funnel = {
      tasks: Number(db.prepare(`SELECT COUNT(*) AS n FROM analytics_events WHERE name='task_published'`).get().n),
      views: Number(db.prepare(`SELECT COUNT(*) AS n FROM analytics_events WHERE name='task_viewed'`).get().n),
      applications: Number(db.prepare(`SELECT COUNT(*) AS n FROM analytics_events WHERE name='application_created'`).get().n),
      assignments: Number(db.prepare(`SELECT COUNT(*) AS n FROM analytics_events WHERE name='executor_selected'`).get().n),
      completions: Number(db.prepare(`SELECT COUNT(*) AS n FROM analytics_events WHERE name='task_closed'`).get().n),
    };
    return json(res, 200, { users, tasks, applications, events, funnel });
  }

  match = path.match(/^\/api\/admin\/tasks\/(\d+)$/);
  if (method === 'PATCH' && match) {
    const admin = requireAdmin(req);
    const taskId = Number(match[1]);
    const body = await readJson(req);
    const row = getTask(taskId);
    if (!row) throw new ApiError(404, 'Задача не найдена');
    const hidden = body.hidden === undefined ? Number(row.is_hidden) : body.hidden ? 1 : 0;
    const status = body.status === undefined ? row.status : body.status;
    if (!TASK_STATUSES.includes(status)) throw new ApiError(422, 'Недопустимый статус');
    db.prepare('UPDATE tasks SET is_hidden=?, status=?, updated_at=? WHERE id=?').run(hidden, status, now(), taskId);
    recordHistory(taskId, admin.id, status, hidden ? 'Скрыто модератором' : 'Изменено модератором');
    return json(res, 200, { ok: true });
  }

  throw new ApiError(404, 'API-метод не найден');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

async function staticFile(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const assetPath = resolve(PUBLIC_DIR, `.${requested}`);
  const isAsset = extname(assetPath) && assetPath.startsWith(PUBLIC_DIR);
  let filePath = isAsset ? assetPath : join(PUBLIC_DIR, 'index.html');
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
    });
    res.end(content);
  } catch {
    if (isAsset) return json(res, 404, { error: 'Файл не найден' });
    filePath = join(PUBLIC_DIR, 'index.html');
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(content);
  }
}

export function createServer() {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else await staticFile(req, res, url);
    } catch (error) {
      if (error instanceof ApiError) return json(res, error.status, { error: error.message, details: error.details });
      console.error(error);
      if (!res.headersSent) json(res, 500, { error: 'Внутренняя ошибка сервера' });
      else res.end();
    }
  });
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`Биржа талантов: http://localhost:${port}`));
}
