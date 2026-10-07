// An in-memory Groq that sorts songs into playlists the way the real model is asked to,
// counts tokens, and can misbehave on purpose: per-minute and per-day 429s, garbled or
// partial replies, answers without numbers, invented playlists, strict mode turned down,
// bad keys, reasoning models that think before answering.
// Like the real API, a request with a strict json_schema response_format gets a JSON reply
// in exactly that shape; otherwise the model answers in lines.
// Used by the Node tests and by tests/demo.html.

export class FakeGroq {
  /**
   * songs: "Title by Artist" (or just "Title") -> playlist id (the model knows that song: confidence high)
   * artists: artist name -> playlist id (used for that artist's other songs: confidence medium)
   * guesses: "Title by Artist" -> playlist id it guesses from weak clues (confidence low)
   * careful: "Title by Artist" -> what it answers when asked to think carefully (high)
   * Anything else is answered "none".
   */
  constructor({ songs = {}, artists = {}, models = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-120b"] } = {}) {
    this.songs = songs;
    this.artists = artists;
    this.models = models;
    this.key = null;             // if set, any other key is rejected
    this.tokensUsed = 0;
    this.requests = 0;
    this.dailyLimit = Infinity;  // tokens; going past it gives a per-day 429
    this.minuteLimitNext = 0;    // next N completions get a per-minute 429
    this.garbleNext = 0;         // next N completions reply with prose instead of answers
    this.preamble = "";          // text the model adds before its answers (line format)
    this.dropEvery = 0;          // leave out every Nth item from replies
    this.skip = null;            // Set of song titles the model never answers
    this.jsonFailNext = 0;       // next N completions: Groq's 400 json_validate_failed
    this.poison = null;          // any batch containing this text gets an unusable reply
    this.unnumbered = false;     // line replies leave out the "N:" numbers
    this.invent = null;          // a playlist the model makes up (line format) for every answer
    this.noSchema = false;       // turn down strict structured output (400)
    this.fromTags = null;        // (artist listener tags) -> playlist id, when only tags are known
    this.fromSongTags = null;    // (song listener tags) -> playlist id, on a careful look
    this.fromStoreGenre = null;  // (Apple Music genre) -> playlist id, on a careful look
    this.guesses = {};
    this.careful = {};
    this.shiftFrom = 0;          // from this song number on, answers belong to the next song
    this.carefulRequests = 0;
    this.systemPrompts = [];
    this.structuredRequests = 0;
    this.calls = [];             // number of songs in each completion request
    this.seen = [];              // every song line sent
  }

  reply(status, body) {
    return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  }

  /** { playlist, confidence, word } for one song line, as the model would answer it. */
  answerFor(line, careful) {
    const m = /^\d+\. "(.*)" by (.*?)(?: \((.*)\))?$/.exec(line);
    if (!m) return { playlist: "none", confidence: "h", word: "" };
    const [, title, artist, extra = ""] = m;
    const key = `${title} by ${artist}`;
    const word = title.split(/\s+/).slice(0, 2).join(" ");
    const songTags = /listener tags for this song: ([^;)]*)/.exec(extra)?.[1];
    if (careful && key in this.careful) return { playlist: this.careful[key], confidence: "h", word };
    if (careful && songTags && this.fromSongTags) return { playlist: this.fromSongTags(songTags), confidence: "h", word };
    const storeGenre = /Apple Music genre: ([^;)]*)/.exec(extra)?.[1];
    if (careful && storeGenre && this.fromStoreGenre) return { playlist: this.fromStoreGenre(storeGenre), confidence: "h", word };
    if (key in this.songs) return { playlist: this.songs[key], confidence: "h", word };
    if (title in this.songs) return { playlist: this.songs[title], confidence: "h", word };
    if (artist in this.artists) return { playlist: this.artists[artist], confidence: "m", word };
    if (key in this.guesses) return { playlist: this.guesses[key], confidence: "l", word };
    const tags = /listener tags for the artist: ([^;)]*)/.exec(extra)?.[1];
    if (tags && this.fromTags) return { playlist: this.fromTags(tags), confidence: "m", word };
    return { playlist: "none", confidence: "h", word };
  }

  fetch = async (url, { headers, body }) => {
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
    const structured = req.response_format?.type === "json_schema";
    if (structured && this.noSchema) {
      this.tokensUsed += promptTokens;
      return this.reply(400, { error: { message: "response_format `json_schema` is not supported with this model", type: "invalid_request_error" } });
    }
    this.requests++;
    if (structured) this.structuredRequests++;
    const lines = req.messages[1].content.split("\n");
    this.calls.push(lines.length);
    this.seen.push(...lines);
    if (this.jsonFailNext-- > 0) {
      this.tokensUsed += promptTokens;
      this.jsonFailures = (this.jsonFailures || 0) + 1;
      return this.reply(400, { error: {
        message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
        type: "invalid_request_error", code: "json_validate_failed",
      } });
    }
    const poisoned = this.poison && lines.some((l) => l.includes(this.poison));
    const careful = req.reasoning_effort === "medium" || /unsure about before/.test(req.messages[0].content);
    if (careful) this.carefulRequests++;
    this.systemPrompts.push(req.messages[0].content);

    const answers = [];
    lines.forEach((line, i) => {
      const n = i + 1;
      if (this.dropEvery && n % this.dropEvery === 0) return;
      if (this.skip && [...this.skip].some((t) => line.includes(`"${t}"`))) return;
      // Losing its place: from shiftFrom on, the model gives each number the next song's answer.
      const source = this.shiftFrom && n >= this.shiftFrom && lines[i + 1] ? lines[i + 1] : line;
      answers.push({ n, ...this.answerFor(source, careful) });
    });

    let content;
    if (structured) {
      // Constrained decoding: always this exact shape, and only ids from the schema's enum.
      const allowed = new Set(req.response_format.json_schema.schema.properties.results.items.properties.p.enum);
      const results = poisoned || this.garbleNext-- > 0 ? []
        : answers.map((a) => ({ n: a.n, w: a.word, p: allowed.has(a.playlist) ? a.playlist : "none", c: a.confidence }));
      content = JSON.stringify({ results }, null, 2); // spaced out, like gpt-oss
    } else {
      content = (this.preamble || "") + answers
        .map((a) => `${this.unnumbered ? "" : `${a.n}: `}${this.invent || a.playlist}`)
        .join("\n");
      if (this.garbleNext-- > 0 || poisoned) content = "I'm sorry, I can't help with that list.";
    }

    // Like gpt-oss on Groq: reasoning models think first, and the thinking uses up
    // max_tokens before any answer is written (less with reasoning_effort "low").
    const thinking = /gpt-oss/.test(req.model) ? (req.reasoning_effort === "low" ? 200 : 900) : 0;
    const room = Math.max(0, req.max_tokens - thinking);
    // Like real Groq: a reply longer than the room left is cut off mid-line.
    let finish = "stop";
    if (Math.ceil(content.length / 3.5) > room) {
      content = content.slice(0, Math.floor(room * 3.5));
      finish = "length";
      this.cutOffs = (this.cutOffs || 0) + 1;
    }
    const completionTokens = Math.ceil(content.length / 3.5) + Math.min(thinking, req.max_tokens);
    this.tokensUsed += promptTokens + completionTokens;
    return this.reply(200, {
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
  };
}

/** How the simulated model sorts the demo library (see demoLibrary in fake-spotify.mjs). */
export function demoGroq() {
  const groq = new FakeGroq({
    artists: {
      "Kendrick Lamar": "conscious-rap",
      "Phoebe Bridgers": "indie-pop",
      "Bad Bunny": "reggaeton",
      "Taylor Swift": "pop",
      "Fred again..": "house",
      "SZA": "contemporary-rnb",
      "Arctic Monkeys": "indie-rock",
      "Zach Bryan": "modern-country",
      "NewJeans": "k-pop",
      "Burna Boy": "afrobeats",
      "Bill Evans": "jazz",
      "Clifton Chenier": "folk-acoustic",
      // "Small Local Band" is unknown to the model on purpose.
    },
    // Some of Taylor Swift's songs are country, one is a ballad.
    songs: {
      "Midnight by Taylor Swift": "modern-country",
      "Golden Hour by Taylor Swift": "modern-country",
      "Paper Planes by Taylor Swift": "pop-ballads",
    },
  });
  // A song it only half-knows: guessed with low confidence, then placed on the careful
  // second look from Apple Music's genre for it.
  groq.guesses = { "Midnight by Small Local Band": "k-pop" };
  groq.fromStoreGenre = (genre) => (genre === "Singer/Songwriter" ? "folk-acoustic" : "none");
  return groq;
}
