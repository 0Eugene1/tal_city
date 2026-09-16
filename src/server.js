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
const TASK_STATUSES = ['DRAFT', 'PENDING_MODERATION', 'PUBLISHED', 'REVIEWING', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'CLOSED'];
const PUBLIC_TASK_STATUSES = ['PUBLISHED'];
const MIN_PROJECT_PRICE = 1_000;
const MAX_PROJECT_PRICE = 100_000_000;
const MIN_HOURLY_RATE = 100;
const MAX_HOURLY_RATE = 100_000;
const MAX_TASK_HORIZON_DAYS = 730;
const RELEVANT_MATCH_SCORE = 50;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const CITIES = [
  'Абакан', 'Барнаул', 'Бердск', 'Екатеринбург', 'Иркутск', 'Кемерово', 'Красноярск',
  'Москва', 'Новокузнецк', 'Новосибирск', 'Омск', 'Санкт-Петербург', 'Томск', 'Тюмень',
];
const PASSWORD_PATTERN_SOURCE = '^(?=.*[A-Za-z])(?=.*\\d)[\\x21-\\x7E]{8,100}$';
const PASSWORD_PATTERN = new RegExp(PASSWORD_PATTERN_SOURCE);
const PASSWORD_MESSAGE = 'Пароль должен содержать от 8 до 100 символов, хотя бы одну латинскую букву и цифру. Допустимы латинские буквы, цифры и специальные символы без пробелов.';
const ALLOWED_FILES = new Map([
  ['application/pdf', '.pdf'], ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
]);

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
    if (raw.length > 15_000_000) throw new ApiError(413, 'Слишком большой запрос');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new ApiError(400, 'Некорректный JSON'); }
}

function text(value, { required = false, min = 0, max = 5000, label = 'Поле', requiredMessage = '', minMessage = '', maxMessage = '' } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new ApiError(422, requiredMessage || `${label}: заполните обязательное поле`);
  if (result && result.length < min) throw new ApiError(422, minMessage || `${label}: минимальная длина — ${min} символов`);
  if (result.length > max) throw new ApiError(422, maxMessage || `${label}: максимальная длина — ${max} символов`);
  return result;
}

function validEmail(value) {
  const email = text(value, { required: true, max: 160, label: 'Email' }).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError(422, 'Введите корректный email');
  return email;
}

function validPassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (!PASSWORD_PATTERN.test(password)) throw new ApiError(422, PASSWORD_MESSAGE);
  return password;
}

function validCity(value) {
  const city = text(value, { required: true, max: 100, label: 'Город' });
  const canonical = CITIES.find((item) => item.toLocaleLowerCase('ru-RU') === city.toLocaleLowerCase('ru-RU'));
  if (!canonical) throw new ApiError(422, 'Выберите город из списка');
  return canonical;
}

function integerInRange(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new ApiError(422, `${label}: укажите целое число от ${min.toLocaleString('ru-RU')} до ${max.toLocaleString('ru-RU')}`);
  }
  return number;
}

function localDateString(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateWithOffset(days) {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + days);
  return localDateString(value);
}

function validDateOnly(value, label, { min, max } = {}) {
  const result = text(value, { required: true, max: 10, label });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new ApiError(422, `${label}: укажите корректную дату`);
  const [year, month, day] = result.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ApiError(422, `${label}: такой даты не существует`);
  }
  if (min && result < min) throw new ApiError(422, `${label}: дата должна быть не раньше ${min}`);
  if (max && result > max) throw new ApiError(422, `${label}: дата должна быть не позже ${max}`);
  return result;
}

function optionalHttpUrl(value, label) {
  const result = text(value, { max: 500, label });
  if (!result) return '';
  try {
    const parsed = new URL(result);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
  } catch {
    throw new ApiError(422, `${label}: используйте полную ссылку с http:// или https://`);
  }
  return result;
}

function list(value, label = 'Навыки') {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  const clean = [...new Set(values.map((item) => text(item, { max: 50 })).filter(Boolean))];
  if (clean.length > 12) throw new ApiError(422, `${label}: не больше 12 значений`);
  return clean;
}

function validateUpload(body, { resume = false } = {}) {
  const originalName = text(body.name, { required: true, max: 180, label: 'Имя файла' }).replace(/[\\/\r\n]/g, '_');
  const mimeType = text(body.mimeType, { required: true, max: 120, label: 'Тип файла' }).toLowerCase();
  const expectedExtension = ALLOWED_FILES.get(mimeType);
  if (!expectedExtension || (resume && mimeType.startsWith('image/'))) throw new ApiError(422, 'Недопустимый тип файла');
  if (extname(originalName).toLowerCase() !== expectedExtension && !(mimeType === 'image/jpeg' && ['.jpeg', '.jpg'].includes(extname(originalName).toLowerCase()))) {
    throw new ApiError(422, 'Расширение файла не соответствует его типу');
  }
  const encoded = text(body.data, { required: true, max: Math.ceil(MAX_FILE_SIZE * 4 / 3) + 16, label: 'Файл' });
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ApiError(422, 'Некорректное содержимое файла');
  const content = Buffer.from(encoded, 'base64');
  if (!content.length || content.length > MAX_FILE_SIZE) throw new ApiError(413, 'Файл превышает лимит 10 МБ');
  return { originalName, mimeType, content };
}

function attachmentMeta(row) {
  return { id: Number(row.id), name: row.original_name, mimeType: row.mime_type, size: Number(row.size), createdAt: row.created_at,
    previewText: row.preview_text || '', url: `/api/attachments/${row.id}`, previewUrl: `/api/attachments/${row.id}?preview=1` };
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
    applicationDeadline: row.application_deadline || row.deadline,
    applicationOpen: row.status === 'PUBLISHED' && (row.application_deadline || row.deadline) >= localDateString(),
    moderationReason: row.moderation_reason || '',
    location: row.location,
    format: row.format,
    customerId: Number(row.customer_id),
    assignedExecutorId: row.assigned_executor_id ? Number(row.assigned_executor_id) : null,
    status: row.status,
    hidden: Boolean(row.is_hidden),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    expired: row.deadline < localDateString(),
    customer: row.customer_name ? {
      id: Number(row.customer_id),
      name: row.customer_name,
      memberSince: row.customer_created_at || undefined,
      publishedTasks: row.customer_published_tasks === undefined ? undefined : Number(row.customer_published_tasks),
      completedTasks: row.customer_completed_tasks === undefined ? undefined : Number(row.customer_completed_tasks),
      organizationName: row.customer_organization_name || '',
      organizationRole: row.customer_organization_role || '',
      location: row.customer_location || '',
      bio: row.customer_bio || '', website: row.customer_website || '',
      verified: row.customer_verification_status === 'VERIFIED',
    } : undefined,
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
    organizationName: row.organization_name || '',
    organizationRole: row.organization_role || '',
    contact: row.contact || '', website: row.website || '', github: row.github || '',
    gitlab: row.gitlab || '', linkedin: row.linkedin || '', specialization: row.specialization || '',
    verificationStatus: row.verification_status || 'PROFILE_INCOMPLETE',
    verificationReason: row.verification_reason || '',
    verificationSubmittedAt: row.verification_submitted_at || null,
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
      verificationStatus: row.executor_verification_status || row.verification_status || 'PROFILE_INCOMPLETE',
    };
    if (taskSkills) result.match = calculateMatch(taskSkills, result.executor.skills);
  }
  return result;
}

function sessionUser(req) {
  const token = readCookies(req.headers.cookie).talent_session;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.name, u.email, u.primary_role, u.is_admin,
      p.completed_at, p.skills, p.location, p.work_format, p.verification_status
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), now());
  if (!row) return null;
  return {
    id: Number(row.id), name: row.name, email: row.email,
    primaryRole: row.primary_role, isAdmin: Boolean(row.is_admin),
    profileCompleted: Boolean(row.completed_at), skills: toJson(row.skills),
    verificationStatus: row.verification_status || 'PROFILE_INCOMPLETE',
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

function requireCustomer(req) {
  const user = requireUser(req);
  if (user.isAdmin || user.primaryRole !== 'CUSTOMER') throw new ApiError(403, 'Действие доступно только заказчику');
  return user;
}

function requireExecutor(req) {
  const user = requireUser(req);
  if (user.isAdmin || user.primaryRole !== 'EXECUTOR') throw new ApiError(403, 'Действие доступно только исполнителю');
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
  return db.prepare(`SELECT t.*, u.name AS customer_name, u.created_at AS customer_created_at,
      cp.organization_name AS customer_organization_name, cp.organization_role AS customer_organization_role,
      cp.location AS customer_location, cp.bio AS customer_bio, cp.website AS customer_website,
      cp.verification_status AS customer_verification_status,
      (SELECT COUNT(*) FROM applications a WHERE a.task_id = t.id AND a.status != 'WITHDRAWN') AS application_count,
      (SELECT COUNT(*) FROM tasks own WHERE own.customer_id=t.customer_id AND own.published_at IS NOT NULL) AS customer_published_tasks,
      (SELECT COUNT(*) FROM tasks own WHERE own.customer_id=t.customer_id AND own.status='CLOSED') AS customer_completed_tasks
    FROM tasks t JOIN users u ON u.id = t.customer_id LEFT JOIN profiles cp ON cp.user_id=u.id WHERE t.id = ?`).get(id);
}

function productMetrics({ demoOnly = false } = {}) {
  const audienceCondition = demoOnly ? "customer.email LIKE '%@demo.city'" : "customer.email NOT LIKE '%@demo.city'";
  const applicationRows = db.prepare(`SELECT t.id AS task_id, t.skills AS task_skills, t.published_at,
      a.id AS application_id, a.created_at AS application_created_at, p.skills AS profile_skills
    FROM tasks t
    JOIN users customer ON customer.id=t.customer_id
    LEFT JOIN applications a ON a.task_id=t.id AND a.status!='WITHDRAWN'
    LEFT JOIN profiles p ON p.user_id=a.executor_id
    WHERE t.published_at IS NOT NULL AND ${audienceCondition}`).all();
  const tasksWithApplications = new Set();
  const tasksWithRelevantCandidates = new Set();
  const firstRelevantHours = new Map();

  for (const row of applicationRows) {
    if (row.application_id === null) continue;
    const taskId = Number(row.task_id);
    tasksWithApplications.add(taskId);
    const match = calculateMatch(toJson(row.task_skills), toJson(row.profile_skills));
    if (match.score < RELEVANT_MATCH_SCORE) continue;
    tasksWithRelevantCandidates.add(taskId);
    const hours = Math.max(0, (new Date(row.application_created_at) - new Date(row.published_at)) / 3_600_000);
    if (!firstRelevantHours.has(taskId) || hours < firstRelevantHours.get(taskId)) firstRelevantHours.set(taskId, hours);
  }

  const times = [...firstRelevantHours.values()].sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const medianHours = times.length
    ? (times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2)
    : null;

  return {
    publishedTasks: Number(db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN users customer ON customer.id=t.customer_id
      WHERE t.published_at IS NOT NULL AND ${audienceCondition}`).get().n),
    tasksWithApplications: tasksWithApplications.size,
    tasksWithRelevantCandidates: tasksWithRelevantCandidates.size,
    assignments: Number(db.prepare(`SELECT COUNT(*) AS n FROM assignments x JOIN tasks t ON t.id=x.task_id
      JOIN users customer ON customer.id=t.customer_id WHERE ${audienceCondition}`).get().n),
    completions: Number(db.prepare(`SELECT COUNT(*) AS n FROM assignments x JOIN tasks t ON t.id=x.task_id
      JOIN users customer ON customer.id=t.customer_id WHERE x.status='CLOSED' AND ${audienceCondition}`).get().n),
    medianFirstRelevantHours: medianHours === null ? null : Math.round(medianHours * 10) / 10,
    relevantMatchThreshold: RELEVANT_MATCH_SCORE,
  };
}

function ensureTaskVisible(row, user) {
  if (!row) throw new ApiError(404, 'Задача не найдена');
  const publicTask = PUBLIC_TASK_STATUSES.includes(row.status) && !row.is_hidden;
  const applicant = user && db.prepare('SELECT 1 FROM applications WHERE task_id=? AND executor_id=?').get(Number(row.id), user.id);
  const participant = user && (user.isAdmin || user.id === Number(row.customer_id) || user.id === Number(row.assigned_executor_id) || applicant);
  if (!publicTask && !participant) throw new ApiError(404, 'Задача не найдена');
}

function validateTask(body) {
  const category = text(body.category, { required: true, max: 50, label: 'Категория' });
  const format = text(body.format, { required: true, max: 20, label: 'Формат' });
  if (!CATEGORIES.includes(category)) throw new ApiError(422, 'Выберите категорию из списка');
  if (!FORMATS.includes(format)) throw new ApiError(422, 'Выберите формат работы');
  const deadline = validDateOnly(body.deadline, 'Срок', { min: dateWithOffset(1), max: dateWithOffset(MAX_TASK_HORIZON_DAYS) });
  const applicationDeadline = validDateOnly(body.applicationDeadline || deadline, 'Приём заявок', { min: localDateString(), max: deadline });
  const skills = list(body.skills);
  if (!skills.length) throw new ApiError(422, 'Компетенции: добавьте хотя бы один навык');
  return {
    title: text(body.title, { required: true, min: 5, max: 120, label: 'Название' }),
    description: text(body.description, { required: true, min: 30, max: 5000, label: 'Описание' }),
    expectedResult: text(body.expectedResult, { required: true, min: 10, max: 1000, label: 'Ожидаемый результат' }),
    category,
    skills,
    budget: integerInRange(body.budget, 'Бюджет', { min: MIN_PROJECT_PRICE, max: MAX_PROJECT_PRICE }),
    deadline,
    applicationDeadline,
    location: validCity(body.location),
    format,
  };
}

function assignmentForTask(taskId) {
  return db.prepare(`SELECT a.*, c.name AS customer_name, c.email AS customer_email,
      e.name AS executor_name, e.email AS executor_email,
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
      (SELECT COUNT(*) FROM tasks WHERE status='PUBLISHED' AND is_hidden = 0 AND deadline >= ?) AS tasks,
      (SELECT COUNT(*) FROM profiles p JOIN users u ON u.id=p.user_id WHERE u.primary_role='EXECUTOR' AND p.verification_status='VERIFIED') AS executors,
      (SELECT COUNT(*) FROM assignments) AS assignments`).get(localDateString());
    return json(res, 200, { user, categories: CATEGORIES, formats: FORMATS, cities: CITIES, passwordPattern: PASSWORD_PATTERN_SOURCE, passwordMessage: PASSWORD_MESSAGE, stats });
  }

  if (method === 'POST' && path === '/api/auth/register') {
    const body = await readJson(req);
    const name = text(body.name, { required: true, min: 2, max: 80, label: 'Имя' });
    const email = validEmail(body.email);
    const password = validPassword(body.password);
    const role = body.role === 'CUSTOMER' ? 'CUSTOMER' : body.role === 'EXECUTOR' ? 'EXECUTOR' : null;
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
    const email = validEmail(body.email);
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
    const row = db.prepare(`SELECT u.id, u.name, u.primary_role, p.* FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`).get(user.id);
    const resume = db.prepare("SELECT id,original_name,mime_type,size,preview_text,created_at FROM attachments WHERE owner_id=? AND kind='RESUME' ORDER BY id DESC LIMIT 1").get(user.id);
    return json(res, 200, { profile: parseProfile(row), role: user.primaryRole, resume: resume || null });
  }

  if (method === 'PUT' && path === '/api/profile/me') {
    const user = requireUser(req);
    if (user.isAdmin) throw new ApiError(403, 'Профиль модератора не участвует в бирже');
    const current = db.prepare('SELECT verification_status FROM profiles WHERE user_id = ?').get(user.id);
    if (current?.verification_status === 'VERIFICATION_PENDING') {
      throw new ApiError(409, 'Профиль находится на проверке и временно недоступен для редактирования.');
    }
    const body = await readJson(req);
    const customer = user.primaryRole === 'CUSTOMER';
    const profile = customer ? {
      bio: text(body.bio, { min: 20, max: 1000, label: 'Рассказ о команде', minMessage: 'Расскажите о команде подробнее — минимум 20 символов.', maxMessage: 'Рассказ о команде: максимальная длина — 1000 символов.' }),
      skills: [], experience: '', portfolio: '',
      location: validCity(body.location), workFormat: 'REMOTE', availability: '', desiredRate: null,
      organizationName: text(body.organizationName, { required: true, min: 2, max: 160, label: 'Организация' }),
      organizationRole: text(body.organizationRole, { required: true, min: 2, max: 120, label: 'Роль' }),
      contact: text(body.contact, { required: true, min: 3, max: 200, label: 'Рабочий контакт' }),
      website: optionalHttpUrl(body.website, 'Сайт'), github: '', gitlab: '', linkedin: '', specialization: '',
    } : {
      bio: text(body.bio, { required: true, min: 20, max: 1000, label: 'О себе', minMessage: 'Расскажите о себе подробнее — минимум 20 символов.', maxMessage: 'О себе: максимальная длина — 1000 символов.' }),
      skills: list(body.skills), experience: text(body.experience, { required: true, min: 20, max: 2000, label: 'Опыт' }),
      portfolio: text(body.portfolio, { max: 500, label: 'Портфолио' }), location: validCity(body.location),
      workFormat: FORMATS.includes(body.workFormat) ? body.workFormat : null,
      availability: text(body.availability, { required: true, max: 200, label: 'Доступность' }),
      desiredRate: body.desiredRate === '' || body.desiredRate === null ? null : integerInRange(body.desiredRate, 'Ставка', { min: MIN_HOURLY_RATE, max: MAX_HOURLY_RATE }),
      organizationName: '', organizationRole: '', contact: '', website: optionalHttpUrl(body.website, 'Сайт'),
      github: optionalHttpUrl(body.github, 'GitHub'), gitlab: optionalHttpUrl(body.gitlab, 'GitLab'),
      linkedin: optionalHttpUrl(body.linkedin, 'LinkedIn'), specialization: text(body.specialization || list(body.skills)[0], { required: true, min: 2, max: 120, label: 'Специализация' }),
    };
    if (!customer && !profile.skills.length) throw new ApiError(422, 'Добавьте хотя бы один навык');
    if (!customer && !profile.workFormat) throw new ApiError(422, 'Выберите формат работы');
    const existed = db.prepare('SELECT completed_at FROM profiles WHERE user_id = ?').get(user.id);
    const timestamp = now();
    db.prepare(`INSERT INTO profiles
      (user_id,bio,skills,experience,portfolio,location,work_format,availability,desired_rate,organization_name,organization_role,contact,website,github,gitlab,linkedin,specialization,verification_status,completed_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PROFILE_COMPLETED',?,?)
      ON CONFLICT(user_id) DO UPDATE SET bio=excluded.bio, skills=excluded.skills, experience=excluded.experience,
      portfolio=excluded.portfolio, location=excluded.location, work_format=excluded.work_format,
      availability=excluded.availability,desired_rate=excluded.desired_rate,organization_name=excluded.organization_name,
      organization_role=excluded.organization_role,contact=excluded.contact,website=excluded.website,github=excluded.github,
      gitlab=excluded.gitlab,linkedin=excluded.linkedin,specialization=excluded.specialization,
      verification_status=CASE WHEN profiles.verification_status='VERIFIED' THEN 'VERIFIED' ELSE 'PROFILE_COMPLETED' END,
      verification_reason='',verification_submitted_at=CASE WHEN profiles.verification_status='VERIFIED' THEN profiles.verification_submitted_at ELSE NULL END,
      completed_at=COALESCE(profiles.completed_at,excluded.completed_at),updated_at=excluded.updated_at`)
      .run(user.id, profile.bio, JSON.stringify(profile.skills), profile.experience, profile.portfolio,
        profile.location, profile.workFormat, profile.availability, profile.desiredRate, profile.organizationName,
        profile.organizationRole, profile.contact, profile.website, profile.github, profile.gitlab, profile.linkedin,
        profile.specialization, timestamp, timestamp);
    if (!existed?.completed_at) track(customer ? 'customer_profile_completed' : 'executor_profile_completed', { userId: user.id });
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && path === '/api/profile/me/submit-verification') {
    const user = requireUser(req);
    const profile = db.prepare('SELECT * FROM profiles WHERE user_id=?').get(user.id);
    if (!profile?.completed_at) throw new ApiError(409, 'Сначала заполните обязательные поля профиля');
    if (profile.verification_status === 'VERIFICATION_PENDING') throw new ApiError(409, 'Профиль уже находится на проверке.');
    if (profile.verification_status === 'VERIFIED') throw new ApiError(409, 'Профиль уже подтверждён');
    if (profile.verification_status !== 'PROFILE_COMPLETED') throw new ApiError(409, 'Сначала сохраните исправленный профиль');
    const submittedAt = now();
    db.prepare("UPDATE profiles SET verification_status='VERIFICATION_PENDING',verification_reason='',verification_submitted_at=?,updated_at=? WHERE user_id=?").run(submittedAt, submittedAt, user.id);
    track(user.primaryRole === 'CUSTOMER' ? 'customer_verification_submitted' : 'executor_verification_submitted', { userId: user.id });
    return json(res, 200, { ok: true, status: 'VERIFICATION_PENDING' });
  }

  if (method === 'POST' && path === '/api/profile/me/resume') {
    const user = requireExecutor(req);
    const profile = db.prepare('SELECT verification_status FROM profiles WHERE user_id=?').get(user.id);
    if (profile?.verification_status === 'VERIFICATION_PENDING') {
      throw new ApiError(409, 'Профиль находится на проверке и временно недоступен для редактирования.');
    }
    const file = validateUpload(await readJson(req), { resume: true });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("DELETE FROM attachments WHERE owner_id=? AND kind='RESUME'").run(user.id);
      const result = db.prepare(`INSERT INTO attachments (owner_id,task_id,kind,original_name,mime_type,size,content,created_at)
        VALUES (?,NULL,'RESUME',?,?,?,?,?)`).run(user.id, file.originalName, file.mimeType, file.content.length, file.content, now());
      db.exec('COMMIT');
      return json(res, 201, { attachment: attachmentMeta({ id: result.lastInsertRowid, original_name: file.originalName, mime_type: file.mimeType, size: file.content.length, created_at: now() }) });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  let attachmentMatch = path.match(/^\/api\/attachments\/(\d+)$/);
  if (method === 'GET' && attachmentMatch) {
    const user = requireUser(req);
    const file = db.prepare('SELECT a.*,t.customer_id,t.status AS task_status,t.assigned_executor_id FROM attachments a LEFT JOIN tasks t ON t.id=a.task_id WHERE a.id=?').get(Number(attachmentMatch[1]));
    if (!file) throw new ApiError(404, 'Вложение не найдено');
    const applicant = file.task_id && db.prepare('SELECT 1 FROM applications WHERE task_id=? AND executor_id=?').get(file.task_id, user.id);
    const resumeCustomer = file.kind === 'RESUME' && db.prepare(`SELECT 1 FROM applications a JOIN tasks t ON t.id=a.task_id
      WHERE a.executor_id=? AND t.customer_id=? LIMIT 1`).get(file.owner_id, user.id);
    const allowed = user.isAdmin || Number(file.owner_id) === user.id || resumeCustomer || (file.task_id && (file.task_status === 'PUBLISHED' || Number(file.customer_id) === user.id || Number(file.assigned_executor_id) === user.id || applicant));
    if (!allowed) throw new ApiError(403, 'Нет доступа к вложению');
    const inline = url.searchParams.get('preview') === '1' && (file.mime_type === 'application/pdf' || file.mime_type.startsWith('image/'));
    res.writeHead(200, { 'Content-Type': file.mime_type, 'Content-Length': file.size, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    return res.end(file.content);
  }

  if (method === 'DELETE' && attachmentMatch) {
    const user = requireUser(req);
    const file = db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(attachmentMatch[1]));
    if (!file) throw new ApiError(404, 'Вложение не найдено');
    if (!user.isAdmin && Number(file.owner_id) !== user.id) throw new ApiError(403, 'Удалить вложение может только владелец');
    if (!user.isAdmin && file.kind === 'RESUME') {
      const profile = db.prepare('SELECT verification_status FROM profiles WHERE user_id=?').get(user.id);
      if (profile?.verification_status === 'VERIFICATION_PENDING') {
        throw new ApiError(409, 'Профиль находится на проверке и временно недоступен для редактирования.');
      }
    }
    db.prepare('DELETE FROM attachments WHERE id=?').run(file.id);
    return json(res, 200, { ok: true });
  }

  let match = path.match(/^\/api\/profile\/(\d+)$/);
  if (method === 'GET' && match) {
    const profileId = Number(match[1]);
    const row = db.prepare(`SELECT u.id, u.name, u.primary_role, u.created_at AS member_since, p.* FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`).get(profileId);
    if (!row) throw new ApiError(404, 'Профиль не найден');
    const reviews = db.prepare(`SELECT r.rating, r.text, r.created_at, u.name AS author_name, t.title AS task_title
      FROM reviews r JOIN users u ON u.id=r.author_id JOIN tasks t ON t.id=r.task_id
      WHERE r.recipient_id=? ORDER BY r.created_at DESC`).all(profileId);
    const activity = db.prepare(`SELECT
      COUNT(*) AS assignments,
      SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS completed_tasks,
      SUM(CASE WHEN status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED','ACCEPTED') THEN 1 ELSE 0 END) AS active_tasks
      FROM assignments WHERE executor_id=?`).get(profileId);
    const rating = db.prepare('SELECT COUNT(*) AS reviews_count, AVG(rating) AS average_rating FROM reviews WHERE recipient_id=?').get(profileId);
    const stats = {
      assignments: Number(activity.assignments || 0),
      completedTasks: Number(activity.completed_tasks || 0),
      activeTasks: Number(activity.active_tasks || 0),
      reviewsCount: Number(rating.reviews_count || 0),
      averageRating: rating.average_rating === null ? null : Math.round(Number(rating.average_rating) * 10) / 10,
    };
    if (row.primary_role === 'CUSTOMER') {
      const customerActivity = db.prepare(`SELECT COUNT(*) AS published_tasks,
        SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS completed_tasks FROM tasks WHERE customer_id=? AND published_at IS NOT NULL`).get(profileId);
      stats.publishedTasks = Number(customerActivity.published_tasks || 0);
      stats.completedTasks = Number(customerActivity.completed_tasks || 0);
    }
    const resumeRow = db.prepare("SELECT id,original_name,mime_type,size,preview_text,created_at FROM attachments WHERE owner_id=? AND kind='RESUME' ORDER BY id DESC LIMIT 1").get(profileId);
    return json(res, 200, { profile: { ...parseProfile(row), role: row.primary_role, memberSince: row.member_since }, reviews, stats, resume: resumeRow ? attachmentMeta(resumeRow) : null });
  }

  if (method === 'GET' && path === '/api/tasks/suggestions') {
    const query = text(url.searchParams.get('q'), { max: 80, label: 'Поиск' }).toLocaleLowerCase('ru-RU');
    const rows = db.prepare(`SELECT id,title FROM tasks
      WHERE status='PUBLISHED' AND is_hidden=0 AND deadline>=? ORDER BY published_at DESC`).all(localDateString());
    const suggestions = rows
      .filter((row) => !query || row.title.toLocaleLowerCase('ru-RU').startsWith(query))
      .slice(0, 8)
      .map((row) => ({ id: Number(row.id), title: row.title }));
    return json(res, 200, { suggestions });
  }

  if (method === 'GET' && path === '/api/tasks') {
    const user = sessionUser(req);
    const where = [`t.status='PUBLISHED'`, 't.is_hidden = 0', 't.deadline >= ?'];
    const params = [localDateString()];
    const searchQuery = (url.searchParams.get('q') || '').slice(0, 80).trim().toLocaleLowerCase('ru-RU');
    if (url.searchParams.get('category')) { where.push('t.category = ?'); params.push(url.searchParams.get('category')); }
    if (url.searchParams.get('skill')) { where.push('t.skills LIKE ?'); params.push(`%${url.searchParams.get('skill').slice(0, 50)}%`); }
    if (url.searchParams.get('format')) { where.push('t.format = ?'); params.push(url.searchParams.get('format')); }
    if (url.searchParams.get('budgetMin')) { where.push('t.budget >= ?'); params.push(Number(url.searchParams.get('budgetMin')) || 0); }
    if (url.searchParams.get('budgetMax')) { where.push('t.budget <= ?'); params.push(Number(url.searchParams.get('budgetMax')) || 999999999); }
    if (url.searchParams.get('deadline')) { where.push('t.deadline <= ?'); params.push(url.searchParams.get('deadline')); }
    const rows = db.prepare(`SELECT t.*, u.name AS customer_name,
      (SELECT COUNT(*) FROM applications a WHERE a.task_id=t.id AND a.status!='WITHDRAWN') AS application_count
      FROM tasks t JOIN users u ON u.id=t.customer_id WHERE ${where.join(' AND ')} ORDER BY t.published_at DESC`).all(...params);
    const visibleRows = searchQuery
      ? rows.filter((row) => [row.title, row.description, row.skills]
        .some((value) => String(value || '').toLocaleLowerCase('ru-RU').includes(searchQuery)))
      : rows;
    const tasks = visibleRows.map((row) => {
      const task = parseTask(row);
      if (user?.profileCompleted) task.match = calculateMatch(task.skills, user.skills);
      return task;
    });
    return json(res, 200, { tasks });
  }

  if (method === 'POST' && path === '/api/tasks') {
    const user = requireCustomer(req);
    if (user.verificationStatus !== 'VERIFIED') throw new ApiError(409, 'Создавать задачи можно только после подтверждения профиля заказчика.');
    const body = await readJson(req);
    const task = validateTask(body);
    const status = 'DRAFT';
    const timestamp = now();
    const result = db.prepare(`INSERT INTO tasks
      (title, description, expected_result, category, skills, budget, deadline, application_deadline, location, format, customer_id, status, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.title, task.description, task.expectedResult, task.category, JSON.stringify(task.skills), task.budget,
        task.deadline, task.applicationDeadline, task.location, task.format, user.id, status, timestamp, timestamp, null);
    const taskId = Number(result.lastInsertRowid);
    recordHistory(taskId, user.id, status, status === 'PUBLISHED' ? 'Задача опубликована' : 'Создан черновик');
    track('task_created', { userId: user.id, taskId });
    return json(res, 201, { taskId, status });
  }

  let taskAttachmentMatch = path.match(/^\/api\/tasks\/(\d+)\/attachments$/);
  if (method === 'POST' && taskAttachmentMatch) {
    const user = requireCustomer(req);
    const taskId = Number(taskAttachmentMatch[1]);
    const task = getTask(taskId);
    if (!task) throw new ApiError(404, 'Задача не найдена');
    if (Number(task.customer_id) !== user.id) throw new ApiError(403, 'Добавлять материалы может только заказчик задачи');
    if (!['DRAFT', 'REJECTED'].includes(task.status)) throw new ApiError(409, 'Материалы можно менять до отправки на модерацию');
    const file = validateUpload(await readJson(req));
    const result = db.prepare(`INSERT INTO attachments (owner_id,task_id,kind,original_name,mime_type,size,content,created_at)
      VALUES (?,?,'TASK',?,?,?,?,?)`).run(user.id, taskId, file.originalName, file.mimeType, file.content.length, file.content, now());
    track('task_attachment_uploaded', { userId: user.id, taskId, metadata: { attachmentId: Number(result.lastInsertRowid), mimeType: file.mimeType, size: file.content.length } });
    return json(res, 201, { attachment: attachmentMeta({ id: result.lastInsertRowid, original_name: file.originalName, mime_type: file.mimeType, size: file.content.length, created_at: now() }) });
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
    const attachmentRows = db.prepare("SELECT id,original_name,mime_type,size,preview_text,created_at FROM attachments WHERE task_id=? AND kind='TASK' ORDER BY id").all(taskId);
    const response = { task, attachments: attachmentRows.map(attachmentMeta) };
    const isOwner = user && (user.id === task.customerId || user.isAdmin);
    if (user && !isOwner) {
      const myApplication = db.prepare('SELECT * FROM applications WHERE task_id=? AND executor_id=?').get(taskId, user.id);
      if (myApplication) response.myApplication = parseApplication(myApplication);
    }
    if (isOwner) {
      const appRows = db.prepare(`SELECT a.*, u.name AS executor_name, p.bio, p.skills AS profile_skills,
        p.experience, p.location AS profile_location, p.work_format, p.desired_rate, p.verification_status AS executor_verification_status
        FROM applications a JOIN users u ON u.id=a.executor_id LEFT JOIN profiles p ON p.user_id=u.id
        WHERE a.task_id=? ORDER BY a.created_at DESC`).all(taskId);
      response.applications = appRows.map((app) => parseApplication(app, task.skills)).sort((a, b) => b.match.score - a.match.score);
      const profileRows = db.prepare(`SELECT u.name, p.* FROM profiles p JOIN users u ON u.id=p.user_id
        WHERE p.completed_at IS NOT NULL AND p.user_id != ?`).all(task.customerId);
      response.recommendations = profileRows.map((profileRow) => {
        const profile = parseProfile(profileRow);
        return { profile, match: calculateMatch(task.skills, profile.skills) };
      }).filter((item) => item.match.score > 0).sort((a, b) => b.match.score - a.match.score).slice(0, 5);
    }
    return json(res, 200, response);
  }

  if (method === 'PUT' && match) {
    const taskId = Number(match[1]);
    const user = requireCustomer(req);
    const row = getTask(taskId);
    if (!row) throw new ApiError(404, 'Задача не найдена');
    if (user.id !== Number(row.customer_id)) throw new ApiError(403, 'Редактировать может только заказчик задачи');
    if (!['DRAFT', 'REJECTED'].includes(row.status)) throw new ApiError(409, 'На модерации и после публикации условия задачи менять нельзя');
    const task = validateTask(await readJson(req));
    const latestOffer = db.prepare(`SELECT MAX(proposed_deadline) AS deadline FROM applications
      WHERE task_id=? AND status IN ('SUBMITTED','SHORTLISTED')`).get(taskId).deadline;
    if (latestOffer && task.deadline < latestOffer) {
      throw new ApiError(409, `Срок задачи не может быть раньше уже предложенного срока ${latestOffer}`);
    }
    db.prepare(`UPDATE tasks SET title=?,description=?,expected_result=?,category=?,skills=?,budget=?,deadline=?,application_deadline=?,location=?,format=?,status='DRAFT',moderation_reason='',updated_at=? WHERE id=?`)
      .run(task.title, task.description, task.expectedResult, task.category, JSON.stringify(task.skills), task.budget,
        task.deadline, task.applicationDeadline, task.location, task.format, now(), taskId);
    return json(res, 200, { ok: true });
  }

  match = path.match(/^\/api\/tasks\/(\d+)\/publish$/);
  if (method === 'POST' && match) {
    const taskId = Number(match[1]);
    const user = requireCustomer(req);
    const row = getTask(taskId);
    if (!row) throw new ApiError(404, 'Задача не найдена');
    if (user.id !== Number(row.customer_id)) throw new ApiError(403, 'Публиковать может только заказчик задачи');
    if (!['DRAFT', 'REJECTED'].includes(row.status)) throw new ApiError(409, 'Задача уже отправлена на модерацию');
    if (user.verificationStatus !== 'VERIFIED') throw new ApiError(409, 'Отправить задачу можно после подтверждения профиля заказчика');
    const timestamp = now();
    db.prepare(`UPDATE tasks SET status='PENDING_MODERATION',moderation_reason='',updated_at=? WHERE id=?`).run(timestamp, taskId);
    recordHistory(taskId, user.id, 'PENDING_MODERATION', 'Задача отправлена на модерацию');
    track('task_submitted_for_moderation', { userId: user.id, taskId });
    return json(res, 200, { ok: true, status: 'PENDING_MODERATION' });
  }

  match = path.match(/^\/api\/tasks\/(\d+)\/applications$/);
  if (method === 'POST' && match) {
    const taskId = Number(match[1]);
    const user = requireExecutor(req);
    const task = getTask(taskId);
    ensureTaskVisible(task, user);
    if (!user.profileCompleted) throw new ApiError(409, 'Сначала заполните профиль исполнителя');
    if (user.id === Number(task.customer_id)) throw new ApiError(409, 'Нельзя откликнуться на собственную задачу');
    if (!PUBLIC_TASK_STATUSES.includes(task.status)) throw new ApiError(409, 'Задача больше не принимает отклики');
    if ((task.application_deadline || task.deadline) < localDateString()) {
      if (!db.prepare("SELECT 1 FROM analytics_events WHERE name='application_deadline_reached' AND task_id=?").get(taskId)) {
        track('application_deadline_reached', { taskId, metadata: { applicationDeadline: task.application_deadline || task.deadline } });
      }
      track('application_blocked_after_deadline', { userId: user.id, taskId });
      throw new ApiError(409, 'Приём заявок завершён — новые отклики недоступны');
    }
    const body = await readJson(req);
    const message = text(body.message, { required: true, min: 20, max: 1500, label: 'Сообщение' });
    const price = integerInRange(body.proposedPrice, 'Стоимость', { min: MIN_PROJECT_PRICE, max: MAX_PROJECT_PRICE });
    const deadline = validDateOnly(body.proposedDeadline, 'Предложенный срок', { min: localDateString(), max: task.deadline });
    try {
      const result = db.prepare(`INSERT INTO applications
        (task_id, executor_id, message, proposed_price, proposed_deadline, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'SUBMITTED', ?)`)
        .run(taskId, user.id, message, price, deadline, now());
      const matchScore = calculateMatch(toJson(task.skills), user.skills).score;
      track('application_created', { userId: user.id, taskId, metadata: { applicationId: Number(result.lastInsertRowid), matchScore } });
      return json(res, 201, { applicationId: Number(result.lastInsertRowid) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new ApiError(409, 'Вы уже откликнулись на эту задачу');
      throw error;
    }
  }

  if (method === 'GET' && path === '/api/applications') {
    const user = requireCustomer(req);
    const rows = db.prepare(`SELECT a.*, t.title AS task_title, t.skills AS task_skills,
      u.name AS executor_name, p.bio, p.skills AS profile_skills, p.experience,
      p.location AS profile_location, p.work_format, p.desired_rate, p.verification_status AS executor_verification_status
      FROM applications a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=a.executor_id
      LEFT JOIN profiles p ON p.user_id=u.id WHERE t.customer_id=? ORDER BY a.created_at DESC`).all(user.id);
    for (const row of rows) track('application_viewed', { userId: user.id, taskId: Number(row.task_id), metadata: { applicationId: Number(row.id) } });
    return json(res, 200, { applications: rows.map((row) => ({ ...parseApplication(row, toJson(row.task_skills)), taskTitle: row.task_title })) });
  }

  match = path.match(/^\/api\/applications\/(\d+)$/);
  if (method === 'GET' && match) {
    const user = requireUser(req);
    const row = db.prepare(`SELECT a.*,t.title AS task_title,t.customer_id,t.skills AS task_skills,u.name AS executor_name,
      p.bio,p.skills AS profile_skills,p.experience,p.location AS profile_location,p.work_format,p.desired_rate,p.verification_status AS executor_verification_status
      FROM applications a JOIN tasks t ON t.id=a.task_id JOIN users u ON u.id=a.executor_id
      LEFT JOIN profiles p ON p.user_id=u.id WHERE a.id=?`).get(Number(match[1]));
    if (!row) throw new ApiError(404, 'Заявка не найдена');
    if (!user.isAdmin && user.id !== Number(row.customer_id) && user.id !== Number(row.executor_id)) throw new ApiError(403, 'Нет доступа к обсуждению этой заявки');
    const comments = db.prepare(`SELECT c.id,c.text,c.created_at,c.author_id,u.name AS author_name
      FROM application_comments c JOIN users u ON u.id=c.author_id WHERE c.application_id=? ORDER BY c.id`).all(row.id);
    track('application_opened', { userId: user.id, taskId: Number(row.task_id), metadata: { applicationId: Number(row.id) } });
    return json(res, 200, { application: { ...parseApplication(row, toJson(row.task_skills)), taskTitle: row.task_title, customerId: Number(row.customer_id) }, comments, viewerId: user.id });
  }

  match = path.match(/^\/api\/applications\/(\d+)\/comments$/);
  if (method === 'POST' && match) {
    const user = requireUser(req);
    const application = db.prepare(`SELECT a.id,a.executor_id,a.task_id,t.customer_id FROM applications a JOIN tasks t ON t.id=a.task_id WHERE a.id=?`).get(Number(match[1]));
    if (!application) throw new ApiError(404, 'Заявка не найдена');
    if (user.id !== Number(application.customer_id) && user.id !== Number(application.executor_id)) throw new ApiError(403, 'Нет доступа к обсуждению этой заявки');
    const body = await readJson(req);
    const comment = text(body.text, { required: true, min: 2, max: 2000, label: 'Комментарий' });
    const result = db.prepare('INSERT INTO application_comments (application_id,author_id,text,created_at) VALUES (?,?,?,?)').run(application.id, user.id, comment, now());
    track('application_comment_created', { userId: user.id, taskId: Number(application.task_id), metadata: { applicationId: Number(application.id), commentId: Number(result.lastInsertRowid) } });
    return json(res, 201, { commentId: Number(result.lastInsertRowid) });
  }

  match = path.match(/^\/api\/applications\/(\d+)\/select$/);
  if (method === 'POST' && match) {
    const user = requireCustomer(req);
    const applicationId = Number(match[1]);
    const app = db.prepare(`SELECT a.*, t.customer_id, t.status AS task_status FROM applications a JOIN tasks t ON t.id=a.task_id WHERE a.id=?`).get(applicationId);
    if (!app) throw new ApiError(404, 'Отклик не найден');
    if (user.id !== Number(app.customer_id)) throw new ApiError(403, 'Исполнителя выбирает заказчик задачи');
    if (app.task_status !== 'PUBLISHED') throw new ApiError(409, 'Для задачи уже выбран исполнитель');
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
    if (user.isAdmin) throw new ApiError(403, 'Для модератора доступна операционная панель');
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
    return json(res, 200, user.primaryRole === 'CUSTOMER'
      ? { created, applied: [], assigned: [] }
      : { created: [], applied, assigned });
  }

  match = path.match(/^\/api\/tasks\/(\d+)\/work$/);
  if (method === 'GET' && match) {
    const taskId = Number(match[1]);
    const { user, assignment } = requireAssignmentAccess(req, taskId);
    const task = parseTask(getTask(taskId));
    const history = db.prepare(`SELECT h.status, h.note, h.created_at, u.name AS actor_name
      FROM task_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.task_id=? ORDER BY h.id`).all(taskId);
    const reviews = db.prepare(`SELECT r.*, u.name AS author_name FROM reviews r JOIN users u ON u.id=r.author_id WHERE r.task_id=? ORDER BY r.id`).all(taskId);
    const counterpart = user.id === Number(assignment.customer_id)
      ? { name: assignment.executor_name, email: assignment.executor_email, role: 'EXECUTOR' }
      : { name: assignment.customer_name, email: assignment.customer_email, role: 'CUSTOMER' };
    const demoSwitch = counterpart.email.endsWith('@demo.city') ? counterpart : null;
    return json(res, 200, { task, assignment: {
      id: Number(assignment.id), taskId, customerId: Number(assignment.customer_id), executorId: Number(assignment.executor_id),
      customerName: assignment.customer_name, executorName: assignment.executor_name, status: assignment.status,
      proposedPrice: Number(assignment.proposed_price), proposedDeadline: assignment.proposed_deadline,
      resultNote: assignment.result_note, resultUrl: assignment.result_url, revisionNote: assignment.revision_note,
    }, history, reviews, viewerId: user.id, demoSwitch });
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
      const resultUrl = optionalHttpUrl(body.resultUrl, 'Ссылка на результат');
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
    const rating = integerInRange(body.rating, 'Оценка', { min: 1, max: 5 });
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
    const users = db.prepare(`SELECT u.id,u.name,u.email,u.primary_role,u.is_admin,u.created_at,p.*,
      (SELECT a.id FROM attachments a WHERE a.owner_id=u.id AND a.kind='RESUME' ORDER BY a.id DESC LIMIT 1) AS resume_id,
      (SELECT a.original_name FROM attachments a WHERE a.owner_id=u.id AND a.kind='RESUME' ORDER BY a.id DESC LIMIT 1) AS resume_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.customer_id=u.id AND t.published_at IS NOT NULL) AS published_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.customer_id=u.id AND t.status='CLOSED') AS completed_tasks,
      (SELECT COUNT(*) FROM reviews r WHERE r.recipient_id=u.id) AS reviews_count
      FROM users u LEFT JOIN profiles p ON p.user_id=u.id ORDER BY u.created_at DESC`).all();
    const tasks = db.prepare(`SELECT t.*,u.name AS customer_name,
      (SELECT COUNT(*) FROM applications a WHERE a.task_id=t.id) AS application_count
      FROM tasks t JOIN users u ON u.id=t.customer_id ORDER BY t.updated_at DESC`).all().map(parseTask);
    const applications = db.prepare('SELECT status, COUNT(*) AS count FROM applications GROUP BY status').all();
    const events = db.prepare('SELECT name, COUNT(*) AS count FROM analytics_events GROUP BY name ORDER BY count DESC').all();
    return json(res, 200, { users, tasks, applications, events, funnel: productMetrics(), demoFunnel: productMetrics({ demoOnly: true }) });
  }

  match = path.match(/^\/api\/admin\/profiles\/(\d+)$/);
  if (method === 'PATCH' && match) {
    const admin = requireAdmin(req);
    const profileId = Number(match[1]);
    const body = await readJson(req);
    const target = db.prepare(`SELECT u.primary_role,p.* FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=?`).get(profileId);
    if (!target) throw new ApiError(404, 'Профиль не найден');
    if (target.verification_status !== 'VERIFICATION_PENDING') throw new ApiError(409, 'Профиль не находится на проверке');
    if (!['approve', 'reject'].includes(body.action)) throw new ApiError(422, 'Выберите подтверждение или отклонение');
    const reason = body.action === 'reject' ? text(body.reason, { required: true, min: 5, max: 1000, label: 'Причина отклонения' }) : '';
    const status = body.action === 'approve' ? 'VERIFIED' : 'REJECTED';
    db.prepare('UPDATE profiles SET verification_status=?,verification_reason=?,updated_at=? WHERE user_id=?').run(status, reason, now(), profileId);
    if (status === 'VERIFIED') track(target.primary_role === 'CUSTOMER' ? 'customer_verified' : 'executor_verified', { userId: profileId, metadata: { moderatorId: admin.id } });
    return json(res, 200, { ok: true, status });
  }

  match = path.match(/^\/api\/admin\/tasks\/(\d+)$/);
  if (method === 'PATCH' && match) {
    const admin = requireAdmin(req);
    const taskId = Number(match[1]);
    const body = await readJson(req);
    const row = getTask(taskId);
    if (!row) throw new ApiError(404, 'Задача не найдена');
    if (body.hidden !== undefined && typeof body.hidden !== 'boolean') throw new ApiError(422, 'Видимость должна быть логическим значением');
    let hidden = body.hidden === undefined ? Number(row.is_hidden) : body.hidden ? 1 : 0;
    const status = body.status === undefined ? row.status : body.status;
    if (!TASK_STATUSES.includes(status)) throw new ApiError(422, 'Недопустимый статус');
    if (status !== row.status) {
      const moderationStatuses = ['PENDING_MODERATION', 'PUBLISHED', 'REJECTED'];
      const allowedTransitions = {
        PENDING_MODERATION: ['PUBLISHED', 'REJECTED'],
      };
      if (!moderationStatuses.includes(row.status) || !allowedTransitions[row.status]?.includes(status)) {
        throw new ApiError(409, 'Модератор не может менять рабочий статус назначения. Используйте действия заказчика и исполнителя.');
      }
      if (status === 'REJECTED') hidden = 1;
      if (status === 'PUBLISHED') hidden = 0;
    }
    const reason = status === 'REJECTED' && status !== row.status
      ? text(body.reason, { required: true, min: 5, max: 1000, label: 'Причина отклонения' })
      : row.moderation_reason || '';
    const timestamp = now();
    db.prepare(`UPDATE tasks SET is_hidden=?,status=?,moderation_reason=?,published_at=CASE WHEN ?='PUBLISHED' THEN COALESCE(published_at, ?) ELSE published_at END,updated_at=? WHERE id=?`)
      .run(hidden, status, reason, status, timestamp, timestamp, taskId);
    const note = status !== row.status
      ? `Модератор изменил статус: ${row.status} → ${status}`
      : hidden !== Number(row.is_hidden) ? (hidden ? 'Скрыто модератором' : 'Снова показано модератором') : 'Проверено модератором';
    recordHistory(taskId, admin.id, status, note);
    if (status !== row.status) track(status === 'PUBLISHED' ? 'task_approved' : 'task_rejected', { userId: admin.id, taskId, metadata: reason ? { reason } : {} });
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
      'Cache-Control': 'no-cache',
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
