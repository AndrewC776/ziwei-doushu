import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { validBirth, findLocalSample, TOPICS } from '../lib/v4-lookup.ts';

test('valid dates, boundaries and strict fields', () => {
  assert.equal(validBirth({year:2000,month:2,day:29,hour:11,gender:'female'}), true);
  assert.equal(validBirth({year:1950,month:1,day:31,hour:0,gender:'male'}), true);
  assert.equal(validBirth({year:2026,month:12,day:31,hour:11,gender:'female'}), true);
  for (const b of [{year:2001,month:2,day:29,hour:0,gender:'male'}, {year:2024,month:4,day:31,hour:0,gender:'male'}, {year:1949,month:1,day:1,hour:0,gender:'male'}, {year:2027,month:1,day:1,hour:0,gender:'male'}, {year:2000,month:1,day:1,hour:12,gender:'male'}, {year:2000,month:1,day:1,hour:0,gender:'other'}]) assert.equal(validBirth(b), false);
});

test('returns all topics for exact key, distinguishes missing and corrupt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ziwei-test-'));
  try {
    const b = {year:2000,month:2,day:29,hour:11,gender:'female'};
    const row = { k:'2000-02-29-11-female', y:2000,m:2,d:29,h:11,g:'female',c:Object.fromEntries(TOPICS.map(k => [k, `text-${k}`])) };
    const data = brotliCompressSync(JSON.stringify([row]));
    await writeFile(path.join(dir,'2000.pack'), data);
    await writeFile(path.join(dir,'2000.json'), JSON.stringify({'2000-02-29':[0,data.length]}));
    assert.equal((await findLocalSample(b,dir)).overview, 'text-overview');
    assert.equal(Object.keys(await findLocalSample(b,dir)).length, 13);
    assert.equal(await findLocalSample({...b,hour:10},dir), null);
    assert.equal(await findLocalSample({...b,month:3,day:1},dir), null);
    await writeFile(path.join(dir,'2000.pack'), 'broken');
    await assert.rejects(findLocalSample(b,dir), /损坏/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
