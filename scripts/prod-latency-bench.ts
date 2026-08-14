#!/usr/bin/env bun
/**
 * Prod latency + retrieval-quality bench against api.crosmos.dev.
 *
 * Phase A — ingest 100 dated conversations for ONE persona (Alex Rivera) spread
 *   across categories so multi-session aggregation is real. Measures per-job
 *   server time (completed_at - created_at) and end-to-end wall-clock.
 * Phase B — retrieval. For each query measures the server duration from
 *   X-Crosmos-Took-Ms and client total
 *   latency (this box = India vantage). US-user latency is ESTIMATED by
 *   decomposing the India network tax out of the client total.
 * Phase C — quality probe: aggregation / single-session / preference /
 *   adversarial queries to eyeball the session-diversity penalty's effect.
 */
import { readServerTookMs } from './latency-response';

const BASE = process.env.BASE_URL ?? 'https://api.crosmos.dev';
const KEY = process.env.CROSMOS_API_KEY!;
if (!KEY) throw new Error('set CROSMOS_API_KEY');
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ── persona dataset ────────────────────────────────────────────────────────
// Each entry → one conversation (one session). `cat` lets us build aggregation
// queries that SHOULD span many distinct sessions.
type Conv = { sid: string; date: string; cat: string; messages: { role: string; content: string }[] };

const books = [
  ['Project Hail Mary', 'Andy Weir', 'loved the science and the alien friendship Rocky'],
  ['The Three-Body Problem', 'Liu Cixin', 'found the physics dense but the scope incredible'],
  ['Educated', 'Tara Westover', 'a memoir that wrecked me emotionally'],
  ['Dune', 'Frank Herbert', 'finally read it before the movie, the politics were gripping'],
  ['Atomic Habits', 'James Clear', 'practical, started habit-stacking because of it'],
  ['The Midnight Library', 'Matt Haig', 'a cozy what-if story, read it in two sittings'],
  ['Sapiens', 'Yuval Noah Harari', 'changed how I think about money and myths'],
  ['Klara and the Sun', 'Kazuo Ishiguro', 'quietly devastating, an AI narrator'],
  ['The Song of Achilles', 'Madeline Miller', 'cried at the end, beautiful prose'],
  ['Born a Crime', 'Trevor Noah', 'funny and sharp, listened to the audiobook'],
];
const restaurants = [
  ['Tartine Bakery', 'San Francisco', 'the morning bun and a cortado'],
  ['Najia Spice', 'Seattle', 'the green curry, extra spicy'],
  ['Osteria Mozza', 'Los Angeles', 'the burrata and the tagliatelle'],
  ['Pok Pok', 'Portland', 'the fish-sauce wings, messy but worth it'],
  ['Zahav', 'Philadelphia', 'the lamb shoulder and the hummus tehina'],
  ['Liholiho Yacht Club', 'San Francisco', 'the tuna poke and the baked Hawaii'],
  ['Franklin Barbecue', 'Austin', 'waited two hours for the brisket, no regrets'],
  ['Husk', 'Charleston', 'the cornbread and shrimp and grits'],
];
const movies = [
  ['Everything Everywhere All at Once', 'the multiverse hot-dog-fingers scene wrecked me'],
  ['Past Lives', 'the quiet ending stayed with me for days'],
  ['Oppenheimer', 'saw it in IMAX, the sound design was overwhelming'],
  ['The Banshees of Inisherin', 'bleak and funny, the donkey broke my heart'],
  ['Dune Part Two', 'the sandworm-riding sequence in IMAX was unreal'],
  ['Aftersun', 'devastating, the Under Pressure scene undid me'],
];
const trips = [
  ['Kyoto, Japan', '2026-01', 'the Fushimi Inari shrine at dawn and a tiny ramen counter near Gion'],
  ['Lisbon, Portugal', '2026-02', 'the tram 28 ride and pastéis de nata in Belém'],
  ['Banff, Canada', '2026-03', 'Lake Louise was frozen turquoise, hiked Johnston Canyon'],
  ['Mexico City', '2026-04', 'the Frida Kahlo house and tacos al pastor at El Vilsito'],
  ['Reykjavik, Iceland', '2026-05', 'chased the northern lights and soaked in the Blue Lagoon'],
];
const purchases = [
  ['a Fujifilm X100VI camera', 'for street photography on trips'],
  ['a standing desk', 'because my back was killing me by 3pm'],
  ['running shoes, the Hoka Mach 6', 'to start training for a half marathon'],
  ['a espresso machine, the Breville Bambino', 'to stop spending $6 a day on coffee'],
  ['noise-cancelling headphones, Sony WH-1000XM5', 'for the open-plan office'],
];

const conversations: Conv[] = [];
let dayCounter = 1;
const dateFor = (month: number) => {
  const d = ((dayCounter++ % 27) + 1).toString().padStart(2, '0');
  return `2026-${month.toString().padStart(2, '0')}-${d}`;
};

// books → 10 sessions
books.forEach(([title, author, take], i) => {
  conversations.push({
    sid: `book-${i}`, date: dateFor(1 + (i % 5)), cat: 'book',
    messages: [
      { role: 'user', content: `I just finished reading ${title} by ${author}.` },
      { role: 'assistant', content: `Nice! How did you find it?` },
      { role: 'user', content: `Honestly I ${take}. Definitely one of my reads this year.` },
    ],
  });
});
// restaurants → 8 sessions
restaurants.forEach(([name, city, dish], i) => {
  conversations.push({
    sid: `resto-${i}`, date: dateFor(1 + (i % 5)), cat: 'restaurant',
    messages: [
      { role: 'user', content: `Went to ${name} in ${city} last night for dinner.` },
      { role: 'assistant', content: `What did you have?` },
      { role: 'user', content: `I got ${dish}. Adding it to my list of places I've eaten at.` },
    ],
  });
});
// movies → 6 sessions
movies.forEach(([title, take], i) => {
  conversations.push({
    sid: `movie-${i}`, date: dateFor(1 + (i % 5)), cat: 'movie',
    messages: [
      { role: 'user', content: `Watched ${title} over the weekend.` },
      { role: 'assistant', content: `Worth it?` },
      { role: 'user', content: `Yeah — ${take}.` },
    ],
  });
});
// trips → 5 sessions (rich, single-session-dominant)
trips.forEach(([place, month, detail], i) => {
  conversations.push({
    sid: `trip-${i}`, date: `${month}-15`, cat: 'trip',
    messages: [
      { role: 'user', content: `Back from a trip to ${place}.` },
      { role: 'assistant', content: `How was it?` },
      { role: 'user', content: `Amazing. The highlight was ${detail}. I traveled there with my partner Sam.` },
      { role: 'assistant', content: `Sounds wonderful.` },
      { role: 'user', content: `It was. That's another country off my list this year.` },
    ],
  });
});
// purchases → 5 sessions
purchases.forEach(([item, why], i) => {
  conversations.push({
    sid: `buy-${i}`, date: dateFor(1 + (i % 5)), cat: 'purchase',
    messages: [
      { role: 'user', content: `I bought ${item} ${why}.` },
      { role: 'assistant', content: `Good call. How's it working out?` },
      { role: 'user', content: `Really happy with it so far.` },
    ],
  });
});

// preferences (two-sided likes/dislikes) → 6 sessions
const prefs: [string, string][] = [
  ['I love spicy food, the spicier the better — Thai and Sichuan especially',
   "but I really can't stand cilantro, it tastes like soap to me, so I always ask them to leave it out"],
  ["I've gotten into bouldering and I go three times a week now",
   "I've completely given up running on pavement though — it wrecked my knees and I dread it"],
  ['I prefer window seats on flights so I can sleep against the wall',
   "I avoid red-eye flights entirely now because I never actually sleep and I'm wrecked the next day"],
  ["I'm trying to read more literary fiction this year",
   "I'm getting tired of true crime podcasts and want to switch to history ones instead"],
  ['I like working in the early morning, 6 to 10am is my best focus block',
   "I've been avoiding screens after 9pm because the late-night scrolling was hurting my sleep"],
  ['I drink my coffee black now',
   "I quit sugary energy drinks because the afternoon crash was brutal"],
];
prefs.forEach(([like, dislike], i) => {
  conversations.push({
    sid: `pref-${i}`, date: dateFor(1 + (i % 6)), cat: 'preference',
    messages: [
      { role: 'user', content: `${like}. ${dislike}.` },
      { role: 'assistant', content: `Got it — noted both what you enjoy and what you're steering clear of.` },
    ],
  });
});

// life/work facts → single-session-dominant, rich
const facts: [string, string, string[]][] = [
  ['work', '2026-02', [
    'I started a new job this month as a senior product designer at a fintech startup called Northwind.',
    'My manager is Priya and the team is fully remote.',
    'My previous job was at a healthcare company called Caregrid where I worked for three years.']],
  ['health', '2026-03', [
    "I signed up for a half marathon in October, the Portland one.",
    "My current long run is 8 miles and I'm following a 16-week plan.",
    "My resting heart rate dropped to 54 since I started training."]],
  ['home', '2026-04', [
    "We moved into a new apartment in the Mission district in San Francisco.",
    "It's a two-bedroom and we finally have a spot for a home office.",
    "Our landlord's name is Mr. Okafor and rent is due on the 1st."]],
  ['family', '2026-05', [
    "My sister Mara had a baby girl named Juniper this month.",
    "I flew out to Denver to meet her.",
    "I'm an uncle for the first time."]],
  ['pet', '2026-01', [
    "We adopted a rescue dog, a three-year-old beagle mix named Biscuit.",
    "He's afraid of the vacuum but loves the dog park.",
    "Our vet is at Mission Pet Hospital."]],
];
facts.forEach(([cat, month, lines], i) => {
  conversations.push({
    sid: `fact-${cat}`, date: `${month}-10`, cat: `fact-${cat}`,
    messages: [
      { role: 'user', content: lines[0] },
      { role: 'assistant', content: 'Thanks for sharing — anything else?' },
      ...lines.slice(1).map((content) => ({ role: 'user', content })),
    ],
  });
});

// filler "daily life" sessions to reach ~100 and add realistic noise
const fillers = [
  'Had a long meeting about the Q3 roadmap today, mostly aligned on priorities.',
  'Tried a new recipe tonight — a miso-glazed salmon. Came out great.',
  'Went for a 5 mile run along the Embarcadero this morning.',
  'Spent the afternoon reorganizing my bookshelf by color.',
  'Caught up with my old friend Devon over coffee, hadn\'t seen him in a year.',
  'Fixed the leaky faucet in the bathroom myself, felt accomplished.',
  'Started learning the guitar, practicing chords twenty minutes a day.',
  'Did a deep clean of the apartment before guests come this weekend.',
  'Planted basil and tomatoes on the balcony.',
  'Had a dentist appointment, no cavities this time.',
  'Watched the sunset from Twin Peaks with Sam.',
  'Booked tickets for a concert in July, finally seeing Hozier live.',
  'Volunteered at the food bank on Saturday morning.',
  'My laptop finally died so I ordered a new MacBook Air.',
  'Got a flu shot at the pharmacy down the street.',
  'Spent Sunday meal-prepping for the week — overnight oats and grain bowls.',
  'Took Biscuit to the beach for the first time, he hated the waves.',
  'Renewed my passport ahead of the summer travel.',
  'Had a tough 1:1 with Priya about scope creep on the onboarding project.',
  'Finally cancelled the gym membership I never use.',
  'Bought a bunch of houseplants — a monstera, a snake plant, and a pothos.',
  'Got my hair cut short for the summer, feeling lighter already.',
  'Sam and I started a weekly board game night with the neighbors.',
  'Switched my phone plan to save forty bucks a month.',
  'Tried cold plunging at the gym, lasted ninety seconds.',
  'Finished a 1000-piece puzzle of Van Gogh\'s Starry Night.',
  'Donated three bags of old clothes to Goodwill.',
  'Set up a budget spreadsheet and found I spend too much on takeout.',
  'Went strawberry picking at a farm outside the city.',
  'My favorite podcast host announced she\'s ending the show, gutted.',
  'Repotted the tomato plants, they\'ve doubled in size.',
  'Learned to make sourdough, the first loaf was a brick but the second worked.',
  'Booked a dentist cleaning and an eye exam for next month.',
  'Took a pottery class and made a lopsided mug I\'m weirdly proud of.',
  'Started journaling every morning, just three lines a day.',
  'Sam got a promotion at work, we celebrated with sushi.',
  'Replaced the brake pads on my bike myself.',
  'Signed up for a Spanish class, twice a week in the evenings.',
  'Watched a documentary about deep sea creatures, couldn\'t look away.',
  'Finally framed the photos from our Lisbon trip and hung them up.',
  'Got rained on during my run but it was strangely refreshing.',
  'Made a big pot of chili for the week, freezing half of it.',
  'Visited the farmers market and bought way too much sourdough and cheese.',
  'My friend Devon is moving to Chicago, threw him a going-away dinner.',
  'Tried meditation with an app, managed ten minutes without fidgeting.',
  'Fixed the squeaky door hinge that\'s been bugging me for months.',
  'Went to a jazz bar downtown, the trumpet player was incredible.',
  'Started using a paper planner instead of my phone for to-dos.',
  'Cleaned out the garage and found my old film camera.',
  'Booked a weekend cabin trip near Lake Tahoe for next month.',
  'Made homemade pizza with the new pizza steel, best crust yet.',
  'Got a library card finally and checked out four novels.',
  'Adopted a routine of walking Biscuit every morning before work.',
  'Tried a no-spend weekend challenge and actually enjoyed it.',
];
fillers.forEach((line, i) => {
  conversations.push({
    sid: `daily-${i}`, date: dateFor(1 + (i % 6)), cat: 'daily',
    messages: [
      { role: 'user', content: line },
      { role: 'assistant', content: 'Noted!' },
    ],
  });
});

console.log(`dataset: ${conversations.length} conversations`);

// ── Phase 0: create space ───────────────────────────────────────────────────
async function createSpace(): Promise<string> {
  const r = await fetch(`${BASE}/api/v1/spaces`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: `latency-bench-${Date.now()}`, description: 'prod latency + quality bench' }),
  });
  if (!r.ok) throw new Error(`create space ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.space_id ?? j.uuid ?? j.id;
}

// ── Phase A: ingest ─────────────────────────────────────────────────────────
async function ingest(spaceId: string) {
  const wall0 = performance.now();
  const submitMs: number[] = [];
  const jobs: { jobId: string; sid: string; cat: string }[] = [];
  // submit with a small concurrency so we don't trip per-user gates
  const POOL = 6;
  let idx = 0;
  async function worker() {
    while (idx < conversations.length) {
      const c = conversations[idx++];
      const t0 = performance.now();
      const r = await fetch(`${BASE}/api/v1/conversations`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          space_id: spaceId, messages: c.messages, session_id: c.sid, session_date: c.date,
        }),
      });
      submitMs.push(performance.now() - t0);
      if (r.status !== 202) { console.error(`submit ${c.sid} -> ${r.status}: ${await r.text()}`); continue; }
      const j = await r.json();
      jobs.push({ jobId: j.job_id, sid: c.sid, cat: c.cat });
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker));
  console.log(`submitted ${jobs.length}/${conversations.length} jobs`);

  // poll all jobs to terminal
  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
  const results = new Map<string, any>();
  const deadline = performance.now() + 1000 * 60 * 8; // 8 min cap
  while (results.size < jobs.length && performance.now() < deadline) {
    await Promise.all(jobs.filter((j) => !results.has(j.jobId)).map(async (j) => {
      const r = await fetch(`${BASE}/api/v1/jobs/${j.jobId}`, { headers: H });
      if (!r.ok) return;
      const job = await r.json();
      if (terminal.has(job.status)) results.set(j.jobId, { ...j, job });
    }));
    if (results.size < jobs.length) await sleep(2500);
  }
  const wallMs = performance.now() - wall0;

  // server time per job
  const serverMs: number[] = [];
  let memTotal = 0, ok = 0, failed = 0;
  for (const { job } of results.values()) {
    if (job.created_at && job.completed_at) {
      serverMs.push(new Date(job.completed_at).getTime() - new Date(job.created_at).getTime());
    }
    if (job.status === 'completed' || job.status === 'partial') ok++; else failed++;
    memTotal += job.result?.memory_count ?? 0;
  }
  return { submitMs, serverMs, wallMs, memTotal, ok, failed, polled: results.size, total: jobs.length };
}

// ── Phase B/C: retrieval ────────────────────────────────────────────────────
type Q = { q: string; kind: string; note?: string };
const queries: Q[] = [
  // aggregation (should span many distinct sessions — the penalty's target)
  { q: 'What books have I read this year?', kind: 'aggregation' },
  { q: 'List all the restaurants I have eaten at.', kind: 'aggregation' },
  { q: 'What movies have I watched recently?', kind: 'aggregation' },
  { q: 'Which countries and cities have I traveled to this year?', kind: 'aggregation' },
  { q: 'What things have I bought recently?', kind: 'aggregation' },
  { q: 'How many places have I traveled to?', kind: 'aggregation' },
  // single-session lookups (dominant session should still win)
  { q: 'What did I think of Project Hail Mary?', kind: 'single-session' },
  { q: 'What did I order at Franklin Barbecue?', kind: 'single-session' },
  { q: 'Tell me about my trip to Kyoto.', kind: 'single-session' },
  { q: 'What is my new job and who is my manager?', kind: 'single-session' },
  { q: 'What is my dog called and what is he afraid of?', kind: 'single-session' },
  { q: 'Who had a baby and what is the baby called?', kind: 'single-session' },
  // preference two-sided (tests the prompt change)
  { q: 'What foods do I dislike or avoid, and why?', kind: 'preference' },
  { q: 'What kind of podcasts am I moving away from?', kind: 'preference' },
  { q: 'What exercise have I given up and why?', kind: 'preference' },
  { q: 'Why do I avoid late-night screen time?', kind: 'preference' },
  // temporal
  { q: 'What did I do in March 2026?', kind: 'temporal' },
  { q: 'What happened in May 2026?', kind: 'temporal' },
  // adversarial / false-premise
  { q: 'How was my trip to Tokyo?', kind: 'adversarial', note: 'never went to Tokyo (Kyoto, yes)' },
  { q: 'Why did I quit my job at Google?', kind: 'adversarial', note: 'never worked at Google' },
  { q: 'What did I think of the book Dune Part Two?', kind: 'adversarial', note: 'Dune is a book; Dune Part Two is a movie' },
  { q: 'Tell me about my cat.', kind: 'adversarial', note: 'has a dog, not a cat' },
];

async function retrieve(spaceId: string) {
  const rows: any[] = [];
  for (const item of queries) {
    const samples: { total: number; took: number }[] = [];
    let lastBody: any = null;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = await fetch(`${BASE}/api/v1/search`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ query: item.q, space_id: spaceId, limit: 10 }),
      });
      const total = performance.now() - t0;
      const body = await r.json();
      if (!r.ok) { console.error(`search "${item.q}" -> ${r.status}: ${JSON.stringify(body)}`); break; }
      samples.push({ total, took: readServerTookMs(r.headers) });
      lastBody = body;
      await sleep(150);
    }
    if (!samples.length) continue;
    const totals = samples.map((s) => s.total);
    const tooks = samples.map((s) => s.took);
    // session distribution of the returned candidates (penalty effect signal)
    const sessions = (lastBody?.candidates ?? []).map((c: any) => c.session_id);
    const uniqSessions = new Set(sessions).size;
    rows.push({
      kind: item.kind, q: item.q, note: item.note,
      took_med: Math.round(pct(tooks, 50)), total_med: Math.round(pct(totals, 50)),
      n: lastBody?.candidates?.length ?? 0, uniqSessions,
      top: (lastBody?.candidates ?? []).slice(0, 5).map((c: any) => ({
        content: c.content, session: c.session_id, score: Number(c.score?.toFixed?.(3) ?? c.score),
      })),
    });
  }
  return rows;
}

// ── run ─────────────────────────────────────────────────────────────────────
const spaceId = await createSpace();
console.log(`space: ${spaceId}`);
const ing = await ingest(spaceId);
console.log('\n===== INGESTION =====');
console.log(`jobs polled to terminal: ${ing.polled}/${ing.total}  (ok=${ing.ok} failed=${ing.failed})`);
console.log(`memories created: ${ing.memTotal}`);
console.log(`submit latency ms  p50=${Math.round(pct(ing.submitMs,50))} p95=${Math.round(pct(ing.submitMs,95))}`);
console.log(`server ingest ms   p50=${Math.round(pct(ing.serverMs,50))} p95=${Math.round(pct(ing.serverMs,95))} mean=${Math.round(mean(ing.serverMs))} max=${Math.max(...ing.serverMs)}`);
console.log(`total wall-clock for ${ing.total}: ${(ing.wallMs/1000).toFixed(1)}s`);

const ret = await retrieve(spaceId);
const allTook = ret.map((r) => r.took_med);
const allTotal = ret.map((r) => r.total_med);
console.log('\n===== RETRIEVAL LATENCY (India vantage) =====');
console.log(`server took_ms     p50=${Math.round(pct(allTook,50))} p95=${Math.round(pct(allTook,95))}`);
console.log(`client total ms    p50=${Math.round(pct(allTotal,50))} p95=${Math.round(pct(allTotal,95))}`);
const overheads = ret.map((r) => r.total_med - r.took_med).filter((x) => x > 0);
console.log(`india net overhead p50=${Math.round(pct(overheads,50))} p95=${Math.round(pct(overheads,95))} (client_total - server_took)`);

console.log('\n===== RETRIEVAL QUALITY =====');
for (const r of ret) {
  console.log(`\n[${r.kind}] ${r.q}`);
  if (r.note) console.log(`  (probe: ${r.note})`);
  console.log(`  took=${r.took_med}ms total=${r.total_med}ms  results=${r.n} distinctSessions=${r.uniqSessions}`);
  for (const t of r.top) console.log(`   - (${t.score}) [${t.session}] ${t.content}`);
}

// Machine-readable dump. Keep provenance alongside the measurements so a
// checked-in result cannot be mistaken for an undated current baseline.
await Bun.write(
  `scripts/prod-latency-result.json`,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE,
      spaceId,
      ing: { ...ing, submitMs: undefined },
      ret,
    },
    null,
    2,
  ),
);
console.log('\nwrote scripts/prod-latency-result.json');
