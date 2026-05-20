// Shared schemas. Every extractor returns one of these; popup branches on `kind`.
//
// Conversation = {
//   kind: 'conversation',
//   source: 'chatgpt' | 'claude' | 'gemini' | 'perplexity',
//   title, url, sessionId?, exportedAt, messages: Message[]
// }
//
// Message = {
//   id, role: 'user'|'assistant'|'system', content, html,
//   reasoning?, attachments?, timestamp?
// }
//
// Profile = {
//   kind: 'profile',
//   source: 'linkedin',
//   profileUrl, slug, name, headline?,
//   experiences: Experience[],
//   extractedAt
// }
//
// Experience = {
//   company, companyUrl?, companyId?, logoUrl?,
//   employmentType?, totalDurationText?,
//   location?, locationType?,                 // company-level (optional; can also live on a Role)
//   roles: Role[]
// }
//
// Role = {
//   title, startDateText?, endDateText?, startDate?, endDate?,
//   durationText?, location?, locationType?,
//   description?, skills: string[], hiddenSkillCount: number
// }

export const SCHEMA_VERSION = 2;

// Human-friendly labels for the lowercase `source` keys that travel inside
// Conversation / Profile objects. The lowercase keys are kept stable in JSON,
// filenames, and the SITES registry — only the user-visible display strings
// (popup meta line, Markdown / Text headers) use these labels.
export const SOURCE_LABELS = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  aistudio: 'AI Studio',
  perplexity: 'Perplexity',
  linkedin: 'LinkedIn',
};

export function prettySource(source) {
  return SOURCE_LABELS[source] || source || '';
}

export function makeConversation({ source, title, url, sessionId, messages }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'conversation',
    source,
    title: title || 'Untitled conversation',
    url: url || (typeof location !== 'undefined' ? location.href : ''),
    ...(sessionId ? { sessionId } : {}),
    exportedAt: new Date().toISOString(),
    messages: messages || [],
  };
}

export function makeMessage({ id, role, content, html, reasoning, attachments, timestamp }) {
  return {
    id: id || cryptoRandomId(),
    role,
    content: content || '',
    html: html || '',
    ...(reasoning ? { reasoning } : {}),
    ...(attachments && attachments.length ? { attachments } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

export function makeProfile({ source, profileUrl, slug, name, headline, experiences }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'profile',
    source,
    profileUrl: profileUrl || (typeof location !== 'undefined' ? location.href : ''),
    slug: slug || '',
    name: name || '',
    ...(headline ? { headline } : {}),
    experiences: experiences || [],
    extractedAt: new Date().toISOString(),
  };
}

function cryptoRandomId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}
