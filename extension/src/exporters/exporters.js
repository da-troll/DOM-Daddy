// Exporters: take a normalized Conversation object and return { filename, blob }.
// All formats run entirely in the browser — no server round-trip.

import { prettySource } from '../lib/schema.js';

const ROLE_LABELS = {
  user: 'You',
  assistant: 'Assistant',
  system: 'System',
};

const MD_ROLE_LABELS = {
  user: '👤 User',
  assistant: '🤖 Assistant',
  system: '⚙️ System',
};

// Shift every ATX heading down by `levels`, capped at h6.
// Skips fenced code blocks so headings inside code are left alone.
function demoteHeadings(md, levels = 2) {
  if (!md) return md;
  const lines = md.split('\n');
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s{0,3})(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) { inFence = true; fenceMarker = marker[0].repeat(marker.length); }
      else if (marker.startsWith(fenceMarker)) { inFence = false; fenceMarker = ''; }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})(\s+)/);
    if (!h) continue;
    const newLevel = Math.min(6, h[1].length + levels);
    lines[i] = '#'.repeat(newLevel) + h[2] + line.slice(h[0].length);
  }
  return lines.join('\n');
}

export function exportMarkdown(conv, opts = {}) {
  const { includeReasoning = true } = opts;
  const parts = [];
  parts.push(`# ${conv.title}\n`);
  parts.push(`*Source: ${prettySource(conv.source)} • Exported: ${formatDate(conv.exportedAt)}*\n`);
  if (conv.url) parts.push(`*URL: ${conv.url}*\n`);

  for (const m of conv.messages) {
    parts.push('\n---\n');
    parts.push(`\n<!-- role: ${m.role} -->\n`);
    parts.push(`**${MD_ROLE_LABELS[m.role] || m.role}**\n`);
    if (m.attachments?.length) {
      parts.push('\n*Attachments: ' + m.attachments.map(a => a.name).join(', ') + '*\n');
    }
    if (includeReasoning && m.reasoning) {
      parts.push('\n<details><summary>Reasoning</summary>\n\n' + demoteHeadings(m.reasoning) + '\n\n</details>\n');
    }
    parts.push('\n' + demoteHeadings(m.content || '') + '\n');
  }

  const text = parts.join('').replace(/\n{3,}/g, '\n\n');
  return {
    filename: filename(conv, 'md'),
    blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }),
  };
}

export function exportText(conv) {
  const lines = [];
  lines.push(conv.title);
  lines.push('='.repeat(conv.title.length));
  lines.push(`Source: ${prettySource(conv.source)}    Exported: ${formatDate(conv.exportedAt)}`);
  if (conv.url) lines.push(`URL: ${conv.url}`);
  lines.push('');

  for (const m of conv.messages) {
    lines.push('');
    lines.push(`[${ROLE_LABELS[m.role] || m.role}]`);
    if (m.attachments?.length) {
      lines.push('Attachments: ' + m.attachments.map(a => a.name).join(', '));
    }
    // Strip Markdown-ish syntax for plain text.
    lines.push(stripMarkdown(m.content));
  }

  return {
    filename: filename(conv, 'txt'),
    blob: new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }),
  };
}

export function exportJSON(conv) {
  const json = JSON.stringify(conv, null, 2);
  return {
    filename: filename(conv, 'json'),
    blob: new Blob([json], { type: 'application/json;charset=utf-8' }),
  };
}

export function exportCSV(conv) {
  // One row per message. Reasoning and attachments serialized into single columns.
  const headers = ['index', 'role', 'content', 'reasoning', 'attachments', 'timestamp'];
  const rows = [headers];

  conv.messages.forEach((m, i) => {
    rows.push([
      i + 1,
      m.role,
      m.content || '',
      m.reasoning || '',
      (m.attachments || []).map(a => a.name).join('; '),
      m.timestamp || '',
    ]);
  });

  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  // BOM so Excel opens UTF-8 correctly.
  return {
    filename: filename(conv, 'csv'),
    blob: new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }),
  };
}

// PDF export: we generate a printable HTML document and let the browser's
// "Save as PDF" handle rendering. This avoids any server dependency.
// The popup opens the HTML in a new tab and triggers window.print().
export function exportPrintableHTML(conv, opts = {}) {
  const { theme = 'light' } = opts;
  const css = getPrintCSS(theme);

  const body = conv.messages.map(m => {
    const label = ROLE_LABELS[m.role] || m.role;
    const reasoning = m.reasoning
      ? `<details class="reasoning"><summary>Reasoning</summary><div>${escapeHtml(m.reasoning).replace(/\n/g, '<br>')}</div></details>`
      : '';
    const attachments = m.attachments?.length
      ? `<div class="attachments">📎 ${m.attachments.map(a => escapeHtml(a.name)).join(', ')}</div>`
      : '';
    // Use the captured HTML when available; fall back to escaped Markdown.
    const content = m.html
      ? m.html
      : `<pre style="white-space:pre-wrap">${escapeHtml(m.content)}</pre>`;
    return `
      <section class="message message--${m.role}">
        <header class="message__role">${label}</header>
        ${attachments}
        ${reasoning}
        <div class="message__content">${content}</div>
      </section>
    `;
  }).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(conv.title)}</title>
  <style>${css}</style>
</head>
<body class="theme--${theme}">
  <header class="doc-header">
    <h1>${escapeHtml(conv.title)}</h1>
    <p class="doc-meta">${prettySource(conv.source)} • ${formatDate(conv.exportedAt)}</p>
    ${conv.url ? `<p class="doc-meta"><a href="${escapeHtml(conv.url)}">${escapeHtml(conv.url)}</a></p>` : ''}
  </header>
  <main>${body}</main>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body>
</html>`;

  return {
    filename: filename(conv, 'html'),
    blob: new Blob([html], { type: 'text/html;charset=utf-8' }),
    html,
  };
}

function getPrintCSS(theme) {
  const dark = theme === 'dark';
  const bg = dark ? '#1a1a1a' : '#ffffff';
  const fg = dark ? '#e8e8e8' : '#1a1a1a';
  const muted = dark ? '#999' : '#666';
  const border = dark ? '#333' : '#e5e5e5';
  const codeBg = dark ? '#0d0d0d' : '#f6f6f6';
  const userBg = dark ? '#2a2a3a' : '#f0f4ff';

  return `
    @page { margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Charter', 'Iowan Old Style', Georgia, serif;
      font-size: 11pt;
      line-height: 1.55;
      color: ${fg};
      background: ${bg};
      max-width: 760px;
      margin: 0 auto;
      padding: 24px;
    }
    .doc-header { border-bottom: 2px solid ${border}; padding-bottom: 16px; margin-bottom: 24px; }
    .doc-header h1 { margin: 0 0 6px; font-size: 22pt; }
    .doc-meta { color: ${muted}; font-size: 9pt; margin: 2px 0; }
    .message { margin: 18px 0; padding: 14px 16px; border-radius: 6px; page-break-inside: avoid; }
    .message--user { background: ${userBg}; }
    .message--assistant { background: transparent; border-left: 3px solid ${border}; }
    .message__role { font-weight: 600; font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.05em; color: ${muted}; margin-bottom: 8px; }
    .message__content { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; }
    .message__content p { margin: 0.6em 0; }
    .message__content pre { background: ${codeBg}; padding: 10px 12px; border-radius: 4px; overflow-x: auto; font-size: 9.5pt; line-height: 1.45; }
    .message__content code { background: ${codeBg}; padding: 1px 5px; border-radius: 3px; font-size: 9.5pt; }
    .message__content pre code { background: transparent; padding: 0; }
    .message__content table { border-collapse: collapse; margin: 1em 0; width: 100%; }
    .message__content th, .message__content td { border: 1px solid ${border}; padding: 6px 10px; text-align: left; }
    .message__content th { background: ${codeBg}; }
    .message__content blockquote { border-left: 3px solid ${border}; padding-left: 12px; margin-left: 0; color: ${muted}; }
    .reasoning { margin: 6px 0 10px; font-size: 9.5pt; color: ${muted}; }
    .reasoning summary { cursor: pointer; user-select: none; }
    .attachments { font-size: 9pt; color: ${muted}; margin-bottom: 6px; }
    a { color: ${dark ? '#7aa2ff' : '#2a5bd7'}; }
    @media print {
      body { padding: 0; }
      .reasoning[open] { display: block; }
    }
  `;
}

// =====================================================================
// Profile exporters (kind === 'profile') — currently LinkedIn experience.
// =====================================================================

export function exportProfileMarkdown(profile) {
  const parts = [];
  parts.push(`# ${profile.name || 'Profile'}\n`);
  if (profile.headline) parts.push(`*${profile.headline}*\n`);
  parts.push(`*Source: ${prettySource(profile.source)} • Exported: ${formatDate(profile.extractedAt)}*\n`);
  if (profile.profileUrl) parts.push(`*URL: ${profile.profileUrl}*\n`);
  parts.push('\n## Experience\n');

  for (const exp of profile.experiences) {
    parts.push(`\n### ${exp.company}`);
    const meta = [];
    if (exp.employmentType) meta.push(exp.employmentType);
    if (exp.totalDurationText) meta.push(exp.totalDurationText);
    if (meta.length) parts.push(`\n*${meta.join(' · ')}*`);
    if (exp.location || exp.locationType) {
      parts.push(`\n*${[exp.location, exp.locationType].filter(Boolean).join(' · ')}*`);
    }
    parts.push('\n');

    for (const role of exp.roles) {
      parts.push(`\n#### ${role.title}`);
      const dates = [
        [role.startDateText, role.endDateText].filter(Boolean).join(' – '),
        role.durationText,
      ].filter(Boolean).join(' · ');
      if (dates) parts.push(`\n*${dates}*`);
      if (role.location || role.locationType) {
        parts.push(`\n*${[role.location, role.locationType].filter(Boolean).join(' · ')}*`);
      }
      if (role.description) parts.push(`\n\n${role.description}`);
      if (role.skills?.length) {
        const more = role.hiddenSkillCount ? ` (+${role.hiddenSkillCount} more)` : '';
        parts.push(`\n\n**Skills:** ${role.skills.join(', ')}${more}`);
      }
      parts.push('\n');
    }
  }

  const text = parts.join('').replace(/\n{3,}/g, '\n\n');
  return {
    filename: filename(profile, 'md'),
    blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }),
  };
}

export function exportProfileJSON(profile) {
  return {
    filename: filename(profile, 'json'),
    blob: new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json;charset=utf-8' }),
  };
}

export function exportProfileCSV(profile) {
  // One row per role (the format people actually want for pivoting).
  const headers = [
    'company', 'companyUrl', 'employmentType', 'companyTotalDuration',
    'roleTitle', 'startDate', 'endDate', 'startDateText', 'endDateText', 'durationText',
    'location', 'locationType', 'description', 'skills', 'hiddenSkillCount',
  ];
  const rows = [headers];

  for (const exp of profile.experiences) {
    for (const role of exp.roles) {
      rows.push([
        exp.company || '',
        exp.companyUrl || '',
        exp.employmentType || '',
        exp.totalDurationText || '',
        role.title || '',
        role.startDate || '',
        role.endDate || '',
        role.startDateText || '',
        role.endDateText || '',
        role.durationText || '',
        role.location || exp.location || '',
        role.locationType || exp.locationType || '',
        role.description || '',
        (role.skills || []).join('; '),
        role.hiddenSkillCount || 0,
      ]);
    }
  }

  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  return {
    filename: filename(profile, 'csv'),
    blob: new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }),
  };
}

// --- helpers ---

function filename(obj, ext) {
  // Profiles: {source}-{slug}-{YYYYMMDD}.{ext}
  // Conversations: {source}-{YYYYMMDD}-{sessionId|titleSlug}.{ext}
  // Date is always the export moment — no host exposes creation date in DOM.
  if (obj.kind === 'profile') {
    const date = (obj.extractedAt || new Date().toISOString()).slice(0, 10).replace(/-/g, '');
    const id = obj.slug || titleSlug(obj.name) || 'profile';
    return `${obj.source}-${id}-${date}.${ext}`;
  }
  const date = obj.exportedAt.slice(0, 10).replace(/-/g, '');
  const id = obj.sessionId || titleSlug(obj.title);
  return `${obj.source}-${date}-${id}.${ext}`;
}

function titleSlug(title) {
  return (title || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'conversation';
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(); }
  catch { return iso; }
}

function csvCell(v) {
  const s = String(v ?? '');
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripMarkdown(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}
