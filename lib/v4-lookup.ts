import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';

export type BirthInfo = { year: number; month: number; day: number; hour: number; gender: 'male' | 'female' };
export const TOPICS = ['overview', 'personality', 'love', 'career', 'wealth', 'health', 'family', 'children', 'move', 'friends', 'home', 'spirit', 'parents'] as const;
const decompress = promisify(brotliDecompress);

export function validBirth(b: BirthInfo | undefined): boolean {
  if (!b || ![b.year, b.month, b.day, b.hour].every(Number.isInteger) || b.year < 1950 || b.year > 2026 || b.month < 1 || b.month > 12 || b.hour < 0 || b.hour > 11 || !['male', 'female'].includes(b.gender)) return false;
  const date = new Date(Date.UTC(b.year, b.month - 1, b.day));
  return date.getUTCFullYear() === b.year && date.getUTCMonth() === b.month - 1 && date.getUTCDate() === b.day;
}

let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < 4) { active++; return; }
  if (waiting.length >= 16) throw new Error('本地查询繁忙，请稍后重试。');
  await new Promise<void>(resolve => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next(); else active--;
}

export async function findLocalSample(b: BirthInfo, directory: string): Promise<Record<string, string> | null> {
  await acquire();
  try { return await readSample(b, directory); } finally { release(); }
}

async function readSample(b: BirthInfo, directory: string): Promise<Record<string, string> | null> {
  if (!validBirth(b)) throw new Error('出生信息无效或不在数据覆盖范围。');
  const date = `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
  const key = `${date}-${b.hour}-${b.gender}`;
  try {
    const index = JSON.parse(await readFile(path.join(directory, `${b.year}.json`), 'utf8'));
    const entry = index[date];
    if (!entry) return null;
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every(Number.isSafeInteger) || entry[0] < 0 || entry[1] <= 0 || entry[1] > 16_000_000) throw new Error('invalid index');
    const file = await open(path.join(directory, `${b.year}.pack`), 'r');
    let data: Buffer;
    try {
      data = Buffer.alloc(entry[1]);
      const { bytesRead } = await file.read(data, 0, data.length, entry[0]);
      if (bytesRead !== data.length) throw new Error('truncated pack');
    } finally { await file.close(); }
    const records = JSON.parse((await decompress(data, { maxOutputLength: 16_000_000 })).toString('utf8'));
    if (!Array.isArray(records)) throw new Error('invalid data');
    const record = records.find(r => r.k === key && r.y === b.year && r.m === b.month && r.d === b.day && r.h === b.hour && r.g === b.gender);
    if (!record) return null;
    if (!record.c || TOPICS.some(k => typeof record.c[k] !== 'string' || !record.c[k])) throw new Error('incomplete record');
    return Object.fromEntries(TOPICS.map(k => [k, record.c[k]]));
  } catch {
    throw new Error('本地 v4 数据不可用或已损坏，请检查数据准备步骤。');
  }
}
