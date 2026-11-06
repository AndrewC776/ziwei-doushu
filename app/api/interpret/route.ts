/**
 * 命理解读：优先查询本地 v4 数据；自由追问可按现有配置调用模型。
 * POST body: { chart, messages, topic? }; 响应使用 SSE，结束发送 [DONE]。
 * 无效日期、超出范围或数据缺失时返回明确提示。
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
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

/** 调用 OpenAI 兼容接口，流式转发 */
async function streamFromLLM(messages: { role: string; content: string }[], send: (t: string) => void) {
  const baseUrl = process.env.MODEL_BASE_URL;
  const apiKey = process.env.MODEL_API_KEY;
  const model = process.env.MODEL_DEFAULT || 'agnes-3.0-flash';
  if (!baseUrl || !apiKey) throw new Error('未配置 MODEL_BASE_URL / MODEL_API_KEY');

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`模型接口返回 ${res.status} ${detail.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content ?? json.delta?.text ?? '';
        if (delta) send(delta);
      } catch {
        /* 忽略无法解析的片段 */
      }
    }
  }
}

/** 把长文本切成小段模拟流式输出 */
async function streamLocalText(text: string, send: (t: string) => void) {
  const chunks = text.match(/[\s\S]{1,80}/g) || [text];
  for (const c of chunks) send(c);
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: '请求体解析失败' }), { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response(JSON.stringify({ error: '请求体格式无效' }), { status: 400 });
  if (body.topic !== undefined && (typeof body.topic !== 'string' || !TOPICS.includes(body.topic))) {
    return new Response(JSON.stringify({ error: '无效的主题' }), { status: 400 });
  }
  const requestedTopic: string | undefined = body.topic;
  const chart = body.chart;
  const messages: { role: string; content: string }[] = Array.isArray(body.messages) ? body.messages.filter((m: any) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').slice(-20) : [];
  const birth: BirthInfo | undefined = chart?.birthInfo;

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUser?.content || '';
  const isFirst = messages.filter((m) => m.role === 'user').length <= 1;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (t: string) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: { text: t } })}\n\n`));
      const sendNote = (t: string) => send(t);
      try {
        let handled = false;
        let generatedByModel = false;

        if (validBirth(birth)) {
          const topics = await findLocalSample(birth as BirthInfo, DATA_DIR);
          if (!topics) { send('本地 v4 数据缺少该出生信息的记录，请重新准备数据。'); return; }
          if (topics) {
            if (requestedTopic) {
              await streamLocalText(topics[requestedTopic], send);
              handled = true;
            } else if (isFirst && !matchTopic(question)) {
              await streamLocalText(topics.overview || '', send);
              handled = true;
            } else {
              const topic = matchTopic(question);
              if (topic && topics[topic]) {
                await streamLocalText(topics[topic], send);
                handled = true;
              } else if (!process.env.MODEL_BASE_URL || !process.env.MODEL_API_KEY) {
                send('当前为本地解读模式，可按出生信息查看已生成的 13 个主题。此类自由追问暂不支持，请选择上方主题查看对应解读。');
                return;
              } else if (topics.overview) {
                // 追问匹配不上主题时，把本地 13 篇作为知识交给大模型作答
                const context = Object.entries(TOPIC_LABELS)
                  .map(([k, label]) => `### ${label}\n${topics[k] || ''}`)
                  .join('\n\n');
                await streamFromLLM(
                  [
                    { role: 'system', content: SYSTEM_PROMPT },
                    {
                      role: 'user',
                      content: `这是该命主已生成的完整命理解读，请严格基于它来回答追问，不要另起炉灶：\n\n${context}\n\n命盘结构：\n${chartToText(chart)}\n\n用户追问：${question}`,
                    },
                  ],
                  send,
                );
                handled = true;
                generatedByModel = true;
              }
            }
            if (generatedByModel) sendNote('\n\n---\n*（此回答由模型基于本地 v4 资料生成）*');
          }
        }

        if (!handled) {
          send('出生信息无效或不在本地 v4 数据覆盖范围 1950–2026 年。');
        }
      } catch (err: any) {
        send(`\n\n解读失败：${err?.message || '未知错误'}`);
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
