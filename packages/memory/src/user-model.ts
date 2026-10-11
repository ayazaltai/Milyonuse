/**
 * Which of the person's own words are worth remembering (ported from Agent
 * 5.5 `memory/usermodel.py`, Honcho-style but poison-resistant).
 *
 * At the end of a turn the person's message is read for durable statements
 * about themselves — "I prefer…", "my name is…", "ben genelde…". Each is
 * *proposed* — never written — and passes the same pipeline as everything
 * else. This only decides what to offer, conservatively: the verifier is the
 * real gate.
 */
const SELF_CUES = [
  /\bi (?:prefer|like|love|hate|dislike|always|usually|never|want|need|use|work|live)\b/iu,
  /\bmy (?:name|email|timezone|time zone|role|job|team|stack|editor|preference|favourite|favorite|birthday)\b/iu,
  /\bi'?m (?:a|an|based|working|located|vegetarian|vegan|allergic)\b/iu,
  /\bi am (?:a|an|based|working|located|vegetarian|vegan|allergic)\b/iu,
  /\bcall me\b/iu,
  /(?<![\p{L}])ben (?:genelde|her zaman|asla|hep|hiç)/iu,
  /(?<![\p{L}])(?:adım|e-?postam|saat dilimim|tercihim|mesleğim|işim)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:severim|sevmem|tercih ederim|kullanırım|yaşıyorum|çalışıyorum)(?![\p{L}])/iu,
];

/** Sentences of the person's message that state a durable fact about them. */
export function candidateObservations(message: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const sentences = message
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 300);
  for (const sentence of sentences) {
    const key = sentence.toLocaleLowerCase('tr');
    if (seen.has(key) || sentence.endsWith('?')) continue;
    if (SELF_CUES.some((cue) => cue.test(sentence))) {
      out.push(sentence);
      seen.add(key);
    }
  }
  return out.slice(0, 5);
}
