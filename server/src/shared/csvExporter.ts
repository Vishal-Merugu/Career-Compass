export interface ICsvColumn {
  label: string;
  key: string;
}

export function generateCSV(data: any[], columns: ICsvColumn[]): string {
  const header = columns.map((c) => escapeCSVField(c.label)).join(',');
  const rows = data.map((item) =>
    columns.map((c) => escapeCSVField(getNestedValue(item, c.key))).join(','),
  );
  return [header, ...rows].join('\n');
}

export function escapeCSVField(val: any): string {
  if (val === null || val === undefined) {
    return '';
  }
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function getNestedValue(obj: any, path: string): string {
  if (!path) return '';
  let current = obj;
  for (const part of path.split('.')) {
    if (current == null) return '';
    current = current[part];
  }
  if (Array.isArray(current)) {
    return current.join('; ');
  }
  return current ?? '';
}

export function createCSVBlobUrl(csvString: string): string {
  if (
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    URL.createObjectURL
  ) {
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    return URL.createObjectURL(blob);
  }
  return '';
}

export interface IParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCSV(csvString: string): IParsedCsv {
  const lines = csvString.trim().split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  return { headers, rows };
}

export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
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

export const CSV_COLUMN_PRESETS: Record<string, ICsvColumn[]> = {
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
