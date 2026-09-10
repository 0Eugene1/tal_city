import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hashPassword } from './auth.js';

const dbPath = resolve(process.env.TALENT_DB_PATH || 'data/talent-city.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    primary_role TEXT NOT NULL CHECK (primary_role IN ('CUSTOMER', 'EXECUTOR')),
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bio TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '[]',
    experience TEXT NOT NULL DEFAULT '',
    portfolio TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    work_format TEXT NOT NULL DEFAULT 'REMOTE',
    availability TEXT NOT NULL DEFAULT '',
    desired_rate INTEGER,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    expected_result TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    skills TEXT NOT NULL DEFAULT '[]',
    budget INTEGER NOT NULL CHECK (budget >= 0),
    deadline TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL CHECK (format IN ('REMOTE', 'ONSITE', 'HYBRID')),
    customer_id INTEGER NOT NULL REFERENCES users(id),
    assigned_executor_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','REVIEWING','ASSIGNED','IN_PROGRESS','SUBMITTED','ACCEPTED','REJECTED','CLOSED')),
    is_hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    executor_id INTEGER NOT NULL REFERENCES users(id),
    message TEXT NOT NULL,
    proposed_price INTEGER NOT NULL CHECK (proposed_price >= 0),
    proposed_deadline TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('SUBMITTED','SHORTLISTED','ACCEPTED','REJECTED','WITHDRAWN')),
    created_at TEXT NOT NULL,
    UNIQUE(task_id, executor_id)
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id),
    customer_id INTEGER NOT NULL REFERENCES users(id),
    executor_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED','ACCEPTED','CLOSED')),
    result_note TEXT NOT NULL DEFAULT '',
    result_url TEXT NOT NULL DEFAULT '',
    revision_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    recipient_id INTEGER NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, author_id)
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    task_id INTEGER REFERENCES tasks(id),
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, is_hidden);
  CREATE INDEX IF NOT EXISTS idx_tasks_customer ON tasks(customer_id);
  CREATE INDEX IF NOT EXISTS idx_applications_task ON applications(task_id);
  CREATE INDEX IF NOT EXISTS idx_applications_executor ON applications(executor_id);
  CREATE INDEX IF NOT EXISTS idx_events_name ON analytics_events(name);
`);

export const now = () => new Date().toISOString();
export const toJson = (value, fallback = []) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

export function track(name, { userId = null, taskId = null, metadata = {} } = {}) {
  db.prepare(`INSERT INTO analytics_events (name, user_id, task_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(name, userId, taskId, JSON.stringify(metadata), now());
}

export function recordHistory(taskId, actorId, status, note = '') {
  db.prepare(`INSERT INTO task_history (task_id, actor_id, status, note, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(taskId, actorId, status, note, now());
}

const seedExecutors = [
  ['Иван Ковалёв', 'ivan@demo.city', ['Python', 'ROS2', 'Computer Vision', 'OpenCV'], 'Разрабатываю автономные системы и компьютерное зрение для городских роботов.', '5 лет в робототехнике, прототипы навигации и распознавания объектов.', 'Новосибирск', 'HYBRID', 1800],
  ['Алёна Мельник', 'alena@demo.city', ['UX Research', 'Figma', 'CJM', 'Интервью'], 'Помогаю командам проверять продуктовые гипотезы через исследования.', 'Провела более 60 глубинных интервью для цифровых продуктов.', 'Томск', 'REMOTE', 1400],
  ['Сергей Волков', 'sergey@demo.city', ['Python', 'FastAPI', 'Telegram Bot', 'PostgreSQL'], 'Backend-разработчик, быстро собираю надёжные сервисы и ботов.', '4 года Python, запускал сервисы для сообществ до 50 000 пользователей.', 'Новосибирск', 'REMOTE', 1700],
  ['Майя Ким', 'maya@demo.city', ['Branding', 'Figma', 'Illustration', 'Event Design'], 'Визуальные системы для событий и технологичных брендов.', 'Айдентика 20+ конференций, навигация и digital-материалы.', 'Новосибирск', 'HYBRID', 1600],
  ['Алексей Громов', 'alexey@demo.city', ['ESP32', 'IoT', 'Sensors', 'C++'], 'Инженер встраиваемых систем: от схемы до рабочего прототипа.', 'Умные счётчики, датчики среды, LoRaWAN и корпусирование.', 'Бердск', 'ONSITE', 1900],
  ['Дарья Орлова', 'daria@demo.city', ['React', 'TypeScript', 'Node.js', 'UI'], 'Создаю быстрые и понятные веб-продукты для ранних стадий.', '6 лет frontend, 15 запущенных MVP.', 'Омск', 'REMOTE', 2000],
  ['Никита Павлов', 'nikita@demo.city', ['Marketing', 'Analytics', 'Yandex Direct', 'Content'], 'Маркетинг с опорой на аналитику и короткие эксперименты.', 'Запускал продвижение локальных сервисов и образовательных проектов.', 'Новосибирск', 'HYBRID', 1500],
  ['Елена Тихонова', 'elena@demo.city', ['Video', 'Editing', 'Motion', 'DaVinci Resolve'], 'Снимаю и монтирую короткие истории о людях и проектах.', 'Документальные ролики, интервью, репортажи с событий.', 'Новосибирск', 'ONSITE', 1300],
  ['Роман Цой', 'roman@demo.city', ['Arduino', 'C++', 'Robotics', 'CAD'], 'Мехатроника и быстрые прототипы роботов.', 'Призёр инженерных соревнований, собирал мобильные платформы.', 'Томск', 'HYBRID', 1200],
  ['Софья Белова', 'sofia@demo.city', ['Copywriting', 'Content', 'SMM', 'Editorial'], 'Редактор технологичных и общественных проектов.', 'Лонгриды, сценарии, контент-стратегии и tone of voice.', 'Удалённо', 'REMOTE', 1100],
  ['Михаил Фролов', 'mikhail@demo.city', ['Data Analysis', 'Python', 'SQL', 'Research'], 'Исследователь данных, превращаю массивы информации в решения.', 'Городская аналитика, опросы и продуктовые метрики.', 'Новосибирск', 'REMOTE', 1750],
  ['Анна Руденко', 'anna@demo.city', ['Product Design', 'Figma', 'Prototyping', 'Design System'], 'Проектирую сервисы от пользовательского сценария до UI.', 'B2B и civic tech, фасилитация продуктовых сессий.', 'Барнаул', 'REMOTE', 1900],
  ['Тимур Сафиуллин', 'timur@demo.city', ['Machine Learning', 'Python', 'NLP', 'LLM'], 'ML-инженер, делаю прикладные модели и измеримые эксперименты.', 'Классификация текстов, RAG и рекомендательные системы.', 'Казань', 'REMOTE', 2300],
  ['Ольга Савина', 'olga@demo.city', ['Event Management', 'Community', 'Partnerships', 'Budgeting'], 'Продюсирую образовательные и городские события.', 'Организовала 30 событий от митапов до фестивалей.', 'Новосибирск', 'ONSITE', 1250],
  ['Артём Лебедев', 'artem@demo.city', ['DevOps', 'Docker', 'Linux', 'CI/CD'], 'Настраиваю понятную инфраструктуру для небольших команд.', 'Автоматизация релизов и наблюдаемость web-сервисов.', 'Кемерово', 'REMOTE', 2100],
  ['Полина Юдина', 'polina@demo.city', ['No-code', 'Tilda', 'SEO', 'Copywriting'], 'Быстро запускаю лендинги и проверяю спрос.', 'Более 40 сайтов для стартапов и событий.', 'Новосибирск', 'REMOTE', 1000],
  ['Владимир Чен', 'vladimir@demo.city', ['Industrial Design', 'CAD', '3D Printing', 'Prototyping'], 'Промышленный дизайнер и инженер прототипирования.', 'Корпуса устройств, 3D-печать и подготовка к производству.', 'Новосибирск', 'ONSITE', 1800],
  ['Ксения Лапина', 'ksenia@demo.city', ['PR', 'Media', 'Copywriting', 'Community'], 'Помогаю полезным инициативам стать заметными.', 'Региональные медиа, спецпроекты и работа с сообществами.', 'Омск', 'REMOTE', 1450],
  ['Денис Морозов', 'denis@demo.city', ['Flutter', 'Dart', 'Firebase', 'Mobile'], 'Разработчик кроссплатформенных мобильных приложений.', 'Приложения для образования, доставки и мероприятий.', 'Новосибирск', 'HYBRID', 2000],
  ['Лилия Ахметова', 'lilia@demo.city', ['Biology', 'Ecology', 'Research', 'GIS'], 'Эколог и исследователь городской среды.', 'Полевые исследования, экологический мониторинг и карты.', 'Новосибирск', 'ONSITE', 1300],
  ['Георгий Ильин', 'georgy@demo.city', ['Vue', 'JavaScript', 'Node.js', 'Telegram Bot'], 'Fullstack-разработчик сервисов для малого бизнеса.', 'Личные кабинеты, интеграции и Telegram Mini Apps.', 'Томск', 'REMOTE', 1800],
  ['Вера Назарова', 'vera@demo.city', ['Service Design', 'CJM', 'Facilitation', 'UX Research'], 'Проектирую услуги вокруг реального пути пользователя.', 'Городские сервисы, образование и клиентский опыт.', 'Новосибирск', 'HYBRID', 1700],
  ['Илья Брагин', 'ilya@demo.city', ['Electronics', 'PCB', 'ESP32', 'Sensors'], 'Разработка электроники и малых серий устройств.', 'Печатные платы, отладка прототипов, подготовка BOM.', 'Бердск', 'ONSITE', 1950],
  ['Марина Зотова', 'marina@demo.city', ['Photography', 'Video', 'Content', 'Event'], 'Визуальный контент для городских проектов.', 'Репортажи, портреты команд и короткие видео для соцсетей.', 'Новосибирск', 'ONSITE', 1200]
];

const seedTasks = [
  ['AI-бот для навигации по сообществу', 'Нужен Telegram-бот, который ответит на частые вопросы участников и поможет найти нужный раздел базы знаний.', 'Работающий бот, репозиторий и инструкция запуска.', 'AI', ['Python', 'Telegram Bot', 'NLP'], 120000, '2026-10-20', 'Новосибирск', 'REMOTE'],
  ['Прототип умной урны', 'Собрать прототип контроля заполненности уличной урны и передачу показаний на простую панель.', 'Стабильный прототип датчика с демонстрацией и схемой.', 'Робототехника', ['ESP32', 'IoT', 'Sensors'], 180000, '2026-11-15', 'Новосибирск', 'HYBRID'],
  ['Система автоматического полива', 'Спроектировать контроллер полива для общественной теплицы с учётом влажности почвы.', 'Прототип на двух зонах, BOM и инструкция.', 'Инженерия', ['Arduino', 'C++', 'Sensors'], 95000, '2026-10-30', 'Бердск', 'ONSITE'],
  ['Лендинг акселератора городских проектов', 'Нужна понятная посадочная страница с программой, наставниками и формой заявки.', 'Адаптивный опубликованный лендинг и передача макетов.', 'IT', ['Tilda', 'Figma', 'Copywriting'], 70000, '2026-10-05', 'Удалённо', 'REMOTE'],
  ['Визуальная система фестиваля науки', 'Разработать ключевой визуал, правила афиш и шаблоны для соцсетей.', 'Концепция, 8 шаблонов и краткий гайд.', 'Дизайн', ['Branding', 'Figma', 'Event Design'], 140000, '2026-11-01', 'Новосибирск', 'HYBRID'],
  ['Прототип робота для навигации в музее', 'Собрать мобильную платформу, которая движется по маркерам и останавливается в заданных точках.', 'Демонстрационный робот, код и видео испытаний.', 'Робототехника', ['ROS2', 'Python', 'Computer Vision'], 260000, '2026-12-10', 'Новосибирск', 'ONSITE'],
  ['Исследование опыта посетителей технопарка', 'Провести интервью с резидентами и гостями, найти барьеры в навигации и сервисе.', 'Отчёт с CJM, 8–10 инсайтами и приоритетами улучшений.', 'Исследования', ['UX Research', 'Интервью', 'CJM'], 85000, '2026-10-18', 'Новосибирск', 'HYBRID'],
  ['Telegram-бот регистрации на мероприятия', 'Бот должен регистрировать гостя, выдавать QR-код и выгружать список организатору.', 'Работающий бот, база регистраций и инструкция.', 'IT', ['Python', 'Telegram Bot', 'PostgreSQL'], 110000, '2026-10-25', 'Удалённо', 'REMOTE'],
  ['Видеоролик о мастерских Города Талантов', 'Снять динамичный ролик о людях, оборудовании и возможностях мастерских.', 'Ролик 90 секунд, тизер 15 секунд и исходники.', 'Контент', ['Video', 'Editing', 'Motion'], 100000, '2026-11-08', 'Новосибирск', 'ONSITE'],
  ['План продвижения набора наставников', 'Найти рабочие каналы привлечения экспертов и запустить первую тестовую кампанию.', 'Медиаплан, креативы, тест кампании и отчёт по лидам.', 'Маркетинг', ['Marketing', 'Analytics', 'Content'], 90000, '2026-10-28', 'Новосибирск', 'REMOTE']
];

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count > 0) return;

  const timestamp = now();
  const demoPassword = hashPassword('demo1234');
  db.exec('BEGIN');
  try {
    const insertUser = db.prepare(`INSERT INTO users (name, email, password_hash, primary_role, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const insertProfile = db.prepare(`INSERT INTO profiles
      (user_id, bio, skills, experience, portfolio, location, work_format, availability, desired_rate, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    insertUser.run('Администратор пилота', 'admin@talent.city', demoPassword, 'CUSTOMER', 1, timestamp);
    const customer = insertUser.run('Мария Соколова', 'customer@demo.city', demoPassword, 'CUSTOMER', 0, timestamp).lastInsertRowid;
    insertUser.run('Центр городских инициатив', 'projects@demo.city', demoPassword, 'CUSTOMER', 0, timestamp);

    for (const [name, email, skills, bio, experience, location, format, rate] of seedExecutors) {
      const userId = insertUser.run(name, email, demoPassword, 'EXECUTOR', 0, timestamp).lastInsertRowid;
      insertProfile.run(userId, bio, JSON.stringify(skills), experience, 'Портфолио доступно по запросу', location, format, 'Готов(а) начать в течение двух недель', rate, timestamp, timestamp);
    }

    const insertTask = db.prepare(`INSERT INTO tasks
      (title, description, expected_result, category, skills, budget, deadline, location, format, customer_id, status, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?)`);
    for (const [title, description, result, category, skills, budget, deadline, location, format] of seedTasks) {
      insertTask.run(title, description, result, category, JSON.stringify(skills), budget, deadline, location, format, customer, timestamp, timestamp, timestamp);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

seed();
