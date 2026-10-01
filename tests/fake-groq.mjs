// An in-memory Groq that knows a fixed set of artists and songs, counts tokens, and can
// misbehave on purpose: per-minute and per-day 429s, garbled or partial replies, bad keys.
// Used by the Node tests and by tests/demo.html.

export class FakeGroq {
  constructor({ artists = {}, songs = {}, models = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] } = {}) {
    this.artists = artists;      // name -> { tags, mixed }
    this.songs = songs;          // title -> tags
    this.models = models;
    this.key = null;             // if set, any other key is rejected
    this.tokensUsed = 0;
    this.requests = 0;
    this.dailyLimit = Infinity;  // tokens; going past it gives a per-day 429
    this.minuteLimitNext = 0;    // next N completions get a per-minute 429
    this.garbleNext = 0;         // next N completions reply with broken JSON
    this.dropEvery = 0;          // leave out every Nth item from replies
    this.calls = [];             // number of items in each completion request
  }
  reply(status, body) {
    return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  }
  fetch = async (url, { method, headers, body }) => {
    if (this.key && headers.Authorization !== `Bearer ${this.key}`) {
      return this.reply(401, { error: { message: "Invalid API Key", code: "invalid_api_key" } });
    }
    if (url.endsWith("/models")) return this.reply(200, { data: this.models.map((id) => ({ id })) });
    const req = JSON.parse(body);
    if (!this.models.includes(req.model)) {
      return this.reply(404, { error: { message: `The model \`${req.model}\` does not exist`, code: "model_not_found" } });
    }
    const prompt = req.messages.map((m) => m.content).join("\n");
    const promptTokens = Math.ceil(prompt.length / 3.5);
    if (this.tokensUsed + promptTokens > this.dailyLimit) {
      return this.reply(429, { error: { message: `Rate limit reached for model \`${req.model}\` on tokens per day (TPD): Limit ${this.dailyLimit}, Used ${this.tokensUsed}. Please try again in 7h12m5.2s.`, type: "tokens" } });
    }
    if (this.minuteLimitNext > 0) {
      this.minuteLimitNext--;
      return this.reply(429, { error: { message: `Rate limit reached for model \`${req.model}\` on tokens per minute (TPM): Limit 12000. Please try again in 2.5s.`, type: "tokens" } });
    }
    this.requests++;
    const lines = req.messages[1].content.split("\n");
    this.calls.push(lines.length);
    const tags = {};
    const mixed = [];
    lines.forEach((line, i) => {
      const n = String(i + 1);
      if (this.dropEvery && (i + 1) % this.dropEvery === 0) return;
      const song = /^\d+\. "(.*)" by (.*)$/.exec(line);
      if (song) { tags[n] = this.songs[song[1]] || []; return; }
      const name = /^\d+\. (.*?)(?: \(songs: .*\))?$/.exec(line)[1];
      const known = this.artists[name];
      tags[n] = known?.tags || [];
      if (known?.mixed) mixed.push(+n);
    });
    const content = this.garbleNext-- > 0 ? '{"tags": {"1": ["hip' : JSON.stringify({ tags, mixed });
    const completionTokens = Math.ceil(content.length / 3.5);
    this.tokensUsed += promptTokens + completionTokens;
    return this.reply(200, {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
  };
}

/** Groq's view of the demo library's artists (see demoLibrary in fake-spotify.mjs). */
export function demoGroq() {
  return new FakeGroq({
    artists: {
      "Kendrick Lamar": { tags: ["conscious hip hop", "west coast rap"] },
      "Phoebe Bridgers": { tags: ["indie pop", "la indie"] },
      "Bad Bunny": { tags: ["reggaeton", "trap latino"] },
      "Taylor Swift": { tags: ["pop", "country pop"], mixed: true },
      "Fred again..": { tags: ["stutter house", "edm"] },
      "SZA": { tags: ["r&b", "pop"] },
      "Arctic Monkeys": { tags: ["garage rock", "modern rock"] },
      "Zach Bryan": { tags: ["classic oklahoma country"] },
      "NewJeans": { tags: ["k-pop girl group"] },
      "Burna Boy": { tags: ["afrobeats", "nigerian pop"] },
      "Bill Evans": { tags: ["cool jazz", "jazz piano"] },
      // "Small Local Band" is unknown to the model on purpose.
    },
    // Taylor Swift's early songs are country, the rest pop.
    songs: { Midnight: ["contemporary country"], "Golden Hour": ["contemporary country"], "Paper Planes": ["country pop"] },
  });
}
