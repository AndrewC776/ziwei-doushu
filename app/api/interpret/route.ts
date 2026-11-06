/**
 * 命理解读：优先查询本地 v4 数据；自由追问可按现有配置调用模型。
 * POST body: { chart, messages, topic? }; 响应使用 SSE，结束发送 [DONE]。
 * 无效日期、超出范围或数据缺失时返回明确提示。
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { validBirth, findLocalSample, TOPICS } from '@/lib/v4-lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel 函数默认超时偏短，AI 流式输出较长，放宽到 60 秒
export const maxDuration = 60;

const DATA_DIR = process.env.ZIWEI_V4_DIR || path.join(process.cwd(), 'data', 'v4-ready');

const TOPIC_LABELS: Record<string, string> = {
  overview: '命格总览',
  personality: '性格特质',
  love: '感情婚姻',
  career: '事业官禄',
  wealth: '财富财运',
  health: '健康养生',
  family: '家庭亲情',
  children: '子女缘分',
  move: '迁移出行',
  friends: '交友人际',
  home: '田宅房产',
  spirit: '精神福德',
  parents: '父母缘分',
};

const TOPIC_KEYWORDS: [string, string[]][] = [
  ['personality', ['性格', '个性', '脾气', '为人', '是什么样的人', '性格特质']],
  ['love', ['感情', '婚姻', '姻缘', '恋爱', '配偶', '夫妻', '另一半', '桃花', '结婚']],
  ['career', ['事业', '工作', '职业', '官禄', '职场', '创业', '学业', '考']],
  ['wealth', ['财富', '财运', '赚钱', '收入', '理财', '破财', '资产', '钱']],
  ['health', ['健康', '身体', '疾病', '养生', '妇科', '病', '体质']],
  ['family', ['家庭', '家人', '亲情', '家运']],
  ['children', ['子女', '孩子', '生育', '儿女', '怀孕']],
  ['move', ['迁移', '出行', '外出', '搬家', '移民', '旅游', '出差']],
  ['friends', ['交友', '朋友', '人际', '贵人', '社交', '下属', '仆役', '同事']],
  ['home', ['田宅', '房产', '房子', '置业', '居家', '买房']],
  ['spirit', ['精神', '信仰', '宗教', '修为', '福德', '内心']],
  ['parents', ['父母', '双亲', '爸妈', '长辈', '亲子']],
];

type BirthInfo = {
  year: number;
  month: number;
  day: number;
  hour: number; // 时辰支索引 0-11
  gender: 'male' | 'female';
  longitude?: number;
};

function matchTopic(text: string): string | null {
  for (const [topic, kws] of TOPIC_KEYWORDS) {
    if (kws.some((k) => text.includes(k))) return topic;
  }
  return null;
}

/** 把命盘压缩成给大模型看的文本摘要 */
function chartToText(chart: any): string {
  if (!chart) return '（无命盘数据）';
  const b = chart.birthInfo || {};
  const lines: string[] = [];
  lines.push(`【出生信息】公历 ${b.year}年${b.month}月${b.day}日 时辰支${b.hour}（0=子…11=亥） 性别 ${b.gender === 'female' ? '女' : '男'}`);
  if (chart.lunarInfo) {
    const l = chart.lunarInfo;
    lines.push(`【农历】${l.lunarYear}年${Math.abs(l.lunarMonth)}月${l.lunarDay}日${l.isLeapMonth ? '（闰月）' : ''}`);
  }
  if (chart.wuxingJuName) lines.push(`【五行局】${chart.wuxingJuName}`);
  if (Array.isArray(chart.palaces)) {
    lines.push('【十二宫】');
    for (const p of chart.palaces) {
      const stars = (p.stars || [])
        .map((s: any) => {
          const hua = s.siHua ? `化${s.siHua}` : '';
          const br = s.brightness ? `(${s.brightness})` : '';
          return `${s.name}${hua}${br}`;
        })
        .join('、');
      const tag = [p.isMingGong ? '命宫' : '', p.isShenGong ? '身宫' : ''].filter(Boolean).join('/');
      lines.push(`  ${p.name}${tag ? `[${tag}]` : ''}（支${p.branch}）: ${stars || '空宫'}`);
    }
  }
  if (Array.isArray(chart.daXians)) {
    lines.push('【大限】' + chart.daXians.map((d: any) => `${d.startAge}-${d.endAge}岁${d.palaceName}`).join('；'));
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `你是精通倪海厦《天纪》紫微斗数体系的专业命理师。

要求：
1. 严格依据倪海厦《天纪》体系论命，不掺杂飞星派等其他流派说法。
2. 必须紧扣用户给出的命盘结构（宫位、星曜、亮度、四化、大限）具体分析，禁止输出放之四海皆准的套话。
3. 语言朴实直接，像老师傅面对面讲评，不用堆砌形容词。
4. 给结论也给理由：先说星曜组合意味着什么，再落到具体影响和可操作建议。
5. 涉及健康只作养生提示，不作医疗诊断。
6. 不编造、不引用无法核实的古籍原文。`;

// 单 Node 进程内串行；不同进程不得共享此额度文件。
const quotaState = globalThis as typeof globalThis & { ziweiQuotaQueue?: Promise<void> };
async function reserveQuota(file: string, limit: number): Promise<boolean> {
  const previous = quotaState.ziweiQuotaQueue || Promise.resolve();
  let release!: () => void;
  quotaState.ziweiQuotaQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const day = new Date().toISOString().slice(0, 10);
    let count = 0;
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (typeof value.day !== 'string' || !Number.isSafeInteger(value.count) || value.count < 0) throw new Error('invalid quota');
      count = value.day === day ? value.count : 0;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (count >= limit) return false;
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ day, count: count + 1 }), { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } finally { await unlink(temp).catch(() => {}); }
    return true;
  } finally { release(); }
}

function boundedEnv(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

async function streamFromLLM(messages: { role: string; content: string }[], send: (t: string) => void, signal: AbortSignal) {
  const baseUrl = process.env.MODEL_BASE_URL!;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MODEL_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-6.1-terra', messages, stream: true, reasoning_effort: 'none', max_completion_tokens: boundedEnv('AI_MAX_OUTPUT_TOKENS', 1200, 2000) }),
  });
  if (!res.ok || !res.body) throw new Error('provider unavailable');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buf += decoder.decode(value, { stream: !done });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      if (done && buf) parts.push(buf);
      for (const line of parts) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content ?? '';
          if (typeof delta === 'string' && delta) send(delta);
        } catch { /* ignore malformed provider event */ }
      }
      if (done) throw new Error('incomplete provider stream');
      if (buf.length > 65536) throw new Error('provider event too large');
    }
  } finally { await reader.cancel().catch(() => {}); }
}

/** 把长文本切成小段模拟流式输出 */
async function streamLocalText(text: string, send: (t: string) => void) {
  const chunks = text.match(/[\s\S]{1,80}/g) || [text];
  for (const c of chunks) send(c);
}

export async function POST(req: NextRequest) {
  let body: any;
  const maxBytes = 100000;
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return new Response('请求过大', { status: 413 });
  try {
    if (!req.body) return new Response('请求体解析失败', { status: 400 });
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return new Response('请求过大', { status: 413 }); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch { return new Response('请求体解析失败', { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response('请求体格式无效', { status: 400 });
  if (body.mode !== undefined && !['local', 'ai'].includes(body.mode)) return new Response('无效的模式', { status: 400 });
  if (body.topic !== undefined && (typeof body.topic !== 'string' || !TOPICS.includes(body.topic))) return new Response('无效的主题', { status: 400 });
  const mode = body.mode || 'local'; // 旧客户端不会触发付费请求
  const chart = body.chart;
  const rawLastUser = Array.isArray(body.messages) ? [...body.messages].reverse().find((m: any) => m?.role === 'user') : undefined;
  if (mode === 'ai' && (!rawLastUser || typeof rawLastUser.content !== 'string' || !rawLastUser.content.trim() || rawLastUser.content.length > 4000)) return new Response('请输入不超过 4000 字的追问。', { status: 400 });
  const messages: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(body.messages)
    ? body.messages.filter((m: any) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.length <= 4000).slice(-10)
    : [];
  const question = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener('abort', onAbort, { once: true });
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (t: string) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: { text: t } })}\n\n`)); };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const birth: BirthInfo | undefined = chart?.birthInfo;
        if (!validBirth(birth)) { send('出生信息无效或不在本地 v4 数据覆盖范围 1950–2026 年。'); return; }
        const topics = await findLocalSample(birth as BirthInfo, DATA_DIR);
        if (!topics) { send('本地 v4 数据缺少该出生信息的记录，请重新准备数据。'); return; }
        if (mode === 'local') {
          const topic = body.topic || matchTopic(question) || 'overview';
          await streamLocalText(topics[topic] || '', send);
          return;
        }
        if (!question.trim() || question.length > 4000) { send('请输入不超过 4000 字的追问。'); return; }
        const limit = boundedEnv('AI_DAILY_LIMIT', 0, 50);
        const quotaFile = process.env.AI_QUOTA_FILE;
        if (process.env.AI_ENABLED !== 'true' || !limit || !quotaFile || !path.isAbsolute(quotaFile) || !process.env.MODEL_BASE_URL || !process.env.MODEL_API_KEY || process.env.MODEL_DEFAULT !== 'gpt-6.1-terra') {
          send('AI 自由追问暂未开放，请选择上方主题查看本地解读。'); return;
        }
        if (!await reserveQuota(quotaFile, limit)) { send('今日 AI 追问额度已用完，请明天再试。'); return; }
        if (abort.signal.aborted) return;
        const relevant = matchTopic(question);
        const context = ['overview', ...(relevant && relevant !== 'overview' ? [relevant] : [])]
          .map(k => `### ${TOPIC_LABELS[k]}\n${(topics[k] || '').slice(0, 6000)}`).join('\n\n');
        const history = messages.slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
        timer = setTimeout(() => abort.abort(), boundedEnv('AI_TIMEOUT_MS', 30000, 55000));
        await streamFromLLM([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'system', content: `以下资料供参考：\n${context}\n\n命盘结构：\n${chartToText(chart).slice(0, 12000)}` }, ...history], send, abort.signal);
      } catch {
        if (!cancelled) send('\n\nAI 解读暂时不可用，请稍后重试。');
      } finally {
        if (timer) clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        if (!cancelled) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
      }
    },
    cancel() { cancelled = true; abort.abort(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
