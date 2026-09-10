const aliases = new Map([
  ['cv', 'computer vision'],
  ['computer vision', 'computer vision'],
  ['ui/ux', 'ui'],
  ['ux/ui', 'ui'],
  ['тг бот', 'telegram bot'],
  ['telegram-бот', 'telegram bot'],
  ['telegram bot', 'telegram bot'],
  ['датчики', 'sensors'],
  ['sensor', 'sensors'],
]);

export function normalizeSkill(value) {
  const normalized = String(value || '')
    .trim()
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9+#.]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return aliases.get(normalized) || normalized;
}

export function calculateMatch(taskSkills = [], executorSkills = []) {
  const required = [...new Set(taskSkills.map(normalizeSkill).filter(Boolean))];
  const available = new Set(executorSkills.map(normalizeSkill).filter(Boolean));
  const matchedNormalized = required.filter((skill) => available.has(skill));
  const matchedSkills = taskSkills.filter((skill) => matchedNormalized.includes(normalizeSkill(skill)));
  const score = required.length ? Math.round((matchedNormalized.length / required.length) * 100) : 0;

  return {
    score,
    matchedSkills,
    explanation: matchedSkills.length
      ? `Совпадают навыки: ${matchedSkills.join(', ')}`
      : 'Точных совпадений пока нет — изучите опыт и предложение кандидата.',
  };
}
