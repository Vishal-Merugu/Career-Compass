// ─── CSV Exporter Service ─────────────────────────────────────────
// Generic CSV generation for any workflow's ResultSet.

function generateCSV(data, columns) {
  const header = columns.map((c) => escapeCSVField(c.label)).join(',');
  const rows = data.map((item) =>
    columns.map((c) => escapeCSVField(getNestedValue(item, c.key))).join(','),
  );
  return [header, ...rows].join('\n');
}

function escapeCSVField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function getNestedValue(obj, path) {
  if (!path) return '';
  let current = obj;
  for (const part of path.split('.')) {
    if (current == null) return '';
    current = current[part];
  }
  if (Array.isArray(current)) return current.join('; ');
  return current ?? '';
}

function createCSVBlobUrl(csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  return URL.createObjectURL(blob);
}

function parseCSV(csvString) {
  const lines = csvString.trim().split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  return { headers, rows };
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

const CSV_COLUMN_PRESETS = {
  peopleFinder: [
    { label: 'Name', key: 'name' },
    { label: 'LinkedIn URL', key: 'linkedinUrl' },
    { label: 'Description', key: 'description' },
    { label: 'Current Role', key: 'currentRole' },
    { label: 'Match Reason', key: 'matchReason' },
    { label: 'Email', key: 'email' },
    { label: 'Email Source', key: 'emailSource' },
    { label: 'Email Validation', key: 'emailValidation' },
    { label: 'Notes', key: 'error' },
  ],
  massConnector: [
    { label: 'Name', key: 'name' },
    { label: 'Status', key: 'status' },
    { label: 'Error', key: 'error' },
    { label: 'Connection Note', key: 'message' },
    { label: 'Email', key: 'email' },
    { label: 'Email Source', key: 'emailSource' },
    { label: 'Email Validation', key: 'emailValidation' },
  ],
};

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    generateCSV,
    escapeCSVField,
    getNestedValue,
    createCSVBlobUrl,
    parseCSV,
    parseCSVLine,
    CSV_COLUMN_PRESETS,
  });
}
