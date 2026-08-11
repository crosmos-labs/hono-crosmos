/**
 * Fixture corpus for the Tier-1 deterministic baseline (P0-A).
 *
 * Shaped after LongMemEval-S: several dated conversation sessions, with the
 * information needed to answer each query deliberately spread across them. That
 * shape is what makes the retrieval assertions meaningful — it exercises
 * multi-session aggregation, session diversity, and temporal reasoning rather
 * than "does semantic search find the one document".
 *
 * Deliberately small (7 sessions, 6 queries). This is a REGRESSION gate, not a
 * quality benchmark: it answers "did our code change the ranking", which needs
 * only enough corpus to make the ranking non-trivial. Measuring answer quality
 * is Tier 2's job, on the full dataset, in the benchmark repo.
 *
 * `goldSessions` names the sessions that actually contain the answer, so recall
 * can be computed rather than eyeballed. Keep them accurate — a wrong gold
 * label turns the recall assertion into noise.
 */

export interface CorpusDoc {
  sessionId: string;
  /** Session date. Drives temporal reasoning and recency scoring. */
  date: string;
  contentType: 'conversation' | 'text';
  content: string;
}

export interface CorpusQuery {
  id: string;
  text: string;
  /** Sessions containing the information needed to answer. */
  goldSessions: string[];
  topK?: number;
  diversify?: boolean;
}

export const CORPUS: CorpusDoc[] = [
  {
    sessionId: 'sess-01-coffee',
    date: '2026-01-08T10:00:00Z',
    contentType: 'conversation',
    content: [
      'user: I finally switched to oat milk in my morning coffee.',
      'assistant: Any particular reason for the switch?',
      'user: Dairy has been upsetting my stomach for a few months now.',
      'assistant: That is common. Oat milk also froths well for lattes.',
      'user: Good, because I make a latte every single morning before work.',
    ].join('\n'),
  },
  {
    sessionId: 'sess-02-cycling',
    date: '2026-01-22T18:30:00Z',
    contentType: 'conversation',
    content: [
      'user: I signed up for a 100km charity bike ride in June.',
      'assistant: That is a solid distance. How long have you been cycling?',
      'user: About three years, but my longest ride so far is only 60km.',
      'assistant: You have time to build up. What bike are you riding?',
      'user: A steel touring bike, it is heavy but I love it.',
    ].join('\n'),
  },
  {
    sessionId: 'sess-03-work',
    date: '2026-02-14T09:15:00Z',
    contentType: 'conversation',
    content: [
      'user: I got promoted to engineering manager last week.',
      'assistant: Congratulations. How large is the team?',
      'user: Six engineers, and two of them are more senior than me.',
      'assistant: Managing former peers can be delicate.',
      'user: Yes, I am nervous about the first performance review cycle.',
    ].join('\n'),
  },
  {
    sessionId: 'sess-04-travel',
    date: '2026-03-02T20:00:00Z',
    contentType: 'conversation',
    content: [
      'user: Booked flights to Lisbon for the last week of April.',
      'assistant: Nice. Is this a holiday or work?',
      'user: Holiday. I want to spend most of it walking and eating pastries.',
      'assistant: Belem is worth the trip for the pasteis de nata.',
      'user: Adding it to the list. I am staying in Alfama.',
    ].join('\n'),
  },
  {
    sessionId: 'sess-05-coffee-followup',
    date: '2026-03-19T08:45:00Z',
    contentType: 'conversation',
    content: [
      'user: The oat milk thing is working, my stomach is much better.',
      'assistant: Good to hear. Are you still doing the daily latte?',
      'user: Every morning, though I switched to a darker roast.',
      'assistant: Darker roasts tend to cut through oat milk better.',
      'user: That is exactly why I changed.',
    ].join('\n'),
  },
  {
    sessionId: 'sess-06-cycling-followup',
    date: '2026-04-11T17:00:00Z',
    contentType: 'conversation',
    content: [
      'user: Did my first 80km ride today, ahead of the June event.',
      'assistant: That is a big jump from 60km. How did it feel?',
      'user: My knees hurt on the last 10km, so I need to fix my saddle height.',
      'assistant: Worth getting a proper bike fit before a 100km.',
      'user: Booking one next week.',
    ].join('\n'),
  },
  {
    sessionId: 'sess-07-reading',
    date: '2026-05-06T21:30:00Z',
    contentType: 'conversation',
    content: [
      'user: I have been reading a lot of translated Japanese fiction lately.',
      'assistant: Any favourites so far?',
      'user: I loved Kitchen by Banana Yoshimoto. Finished it in two evenings.',
      'assistant: Short and very atmospheric.',
      'user: I want something longer next, maybe under 500 pages.',
    ].join('\n'),
  },
];

export const QUERIES: CorpusQuery[] = [
  {
    id: 'q1-single-session',
    text: 'why did I stop drinking dairy milk',
    goldSessions: ['sess-01-coffee'],
  },
  {
    id: 'q2-multi-session',
    // Needs both coffee sessions: the switch and the later roast change.
    text: 'what do I drink in the morning and how has it changed',
    goldSessions: ['sess-01-coffee', 'sess-05-coffee-followup'],
  },
  {
    id: 'q3-temporal',
    text: 'what am I training for in June',
    goldSessions: ['sess-02-cycling', 'sess-06-cycling-followup'],
  },
  {
    id: 'q4-knowledge-update',
    // The longest-ride fact is superseded across sessions (60km then 80km).
    text: 'what is the longest bike ride I have done',
    goldSessions: ['sess-06-cycling-followup'],
  },
  {
    id: 'q5-work',
    text: 'how many people do I manage',
    goldSessions: ['sess-03-work'],
  },
  {
    id: 'q6-diversify',
    // Broad query — exercises session-diverse selection across unrelated topics.
    text: 'what are my hobbies and interests',
    goldSessions: ['sess-02-cycling', 'sess-07-reading'],
    diversify: true,
    topK: 8,
  },
];
