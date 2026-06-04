# r/wallstreetbets + Discord — source reference

> Compiled 2026-06-03 from primary sources (the subreddit's own moderator-maintained wiki/rules,
> the live Discord API, Wikipedia, and 2021 news coverage). Live counts are snapshots and drift.
> Uncertainties are flagged `[uncertain]`. This doc exists so the WSB Signals pipeline knows
> *what the data looks like* and *what to trust*.

## 1. What it is

**r/wallstreetbets** ("WSB") is a subreddit for discussing stock and options trading, defined by
aggressive high-risk strategies, leverage, "YOLO" all-in bets, meme stocks, and a profane,
self-deprecating culture. Public tagline: **"Like 4chan found a Bloomberg Terminal."**

- **Founded:** 2012-01-31 by **Jaime Rogozinski**. Reddit removed him as moderator in April 2020
  (trademark dispute); his 2023 lawsuit against Reddit was dismissed.
- **Defining event:** the **January 2021 GameStop (GME) short squeeze** — WSB-driven buying pushed
  GME up >600% by Jan 26, halting trading repeatedly and inflicting large losses on short-selling
  hedge funds. The sub gained ~2.4M subscribers in one week.
- Source: <https://en.wikipedia.org/wiki/R/wallstreetbets>

## 2. Scale (and a counting caveat)

| Date | Subscribers | Source |
|---|---|---|
| End 2016 | ~100k | Wikipedia |
| 2021-01-24 | 2.06M | Wikipedia |
| 2021-01-29 | 6.2M | Wikipedia |
| End 2022 | 13.3M | Wikipedia |
| "As of 2026" | **19.9M** | Wikipedia |

> `[uncertain]` **The current headcount is genuinely ambiguous.** Wikipedia cites 19.9M (cumulative
> subscribers). A third-party tracker cited ~4.1M (March 2026). The gap is most likely **Reddit's
> 2025 change** that stopped showing subscriber counts on subreddit pages (switching to
> "visitors"/activity metrics). For signal purposes the absolute number matters less than **daily
> active posting volume**, which you should measure directly (see Arctic-Shift `time_series`
> `r/wallstreetbets/comments/count`).

## 3. Culture & lexicon (matters for NLP/sentiment)

WSB slang inverts and overloads normal sentiment words; an off-the-shelf sentiment model **will
misread it**. Essentials:

- **Bullish:** "diamond hands" 💎🙌 (hold through volatility), "to the moon" 🚀, "tendies" (profits),
  "YOLO", "calls", "loading up", "apes together strong".
- **Bearish:** "puts", "drilling", "bagholder", "guh", "it's over".
- **Inverted/ironic:** the sub celebrates **losses** ("loss porn") and mocks itself ("degenerate
  gamblers", "regards"). A post full of negative words may be a *proud* loss post, not fear.
- **"Paper hands"** = selling too early (a pejorative — *negative* about the seller, not the stock).
- Implication: **direction (calls/puts, "bought"/"sold") and flair are more reliable than generic
  sentiment polarity.** Treat lexical sentiment as one weak feature, not ground truth. Source:
  <https://en.wikipedia.org/wiki/R/wallstreetbets>

## 4. Flair taxonomy — the backbone of empirical signals

WSB enforces a **link-flair taxonomy**; mislabeling (e.g. tagging a shitpost "DD") can earn a ban,
so flair is a relatively *high-integrity* label. Each flair maps to a different signal.
Definitions are from the WSB flair wiki / rules (<https://old.reddit.com/r/wallstreetbets/wiki/linkflair>,
<https://old.reddit.com/r/wallstreetbets/about/rules/>):

| Flair | Meaning | Signal value |
|---|---|---|
| **DD** | "Due Diligence" — high-effort research post w/ sources. | Conviction / thesis; often *leads* attention. |
| **YOLO** | High-risk bet; **min $10k options or $25k shares**, position screenshot required. | Strong directional conviction + skin in the game. |
| **Gain** | Winning trade; **min $2.5k options / $5k shares**, must show the position. | Realized outcome (bullish survivorship — see §8). |
| **Loss** | Losing trade; same minimums, must show the position. | Realized outcome; capitulation / contrarian. |
| **Discussion** | An idea/article to talk about (more than "up or down today?"). | General attention. |
| **News** | Market-moving news. | Catalyst. |
| **Meme / Shitpost** | Low-information humor. | Hype/attention proxy; noise for sentiment. |
| **Earnings Thread** | Weekly/by-event earnings discussion (mod-posted). | Scheduled catalyst window. |
| **Daily Discussion** | Auto-posted daily catch-all (by `wsbapp`/automod). | **Highest-volume comment stream** — see §5. |

> `[uncertain]` The flair wiki (last revised ~5 yrs ago) lists Gain/Loss share-minimum as **$10k**;
> the current **rules page and content guide say $5k**. Trust the rules page ($2.5k options / $5k
> shares). YOLO minimums ($10k/$25k) are consistent across pages.

## 5. Recurring auto-threads (high-value comment streams)

- **Daily Discussion Thread** — auto-posted **every day** by `wsbapp`/automod (e.g. "Daily
  Discussion Thread for June 03, 2026"). This single thread carries a huge share of the day's
  ticker chatter in its **comments**, not as standalone posts. **For mention-volume signals, the
  Daily thread's comment stream is the richest source** — a pipeline that only reads top-level
  posts will miss most of the conversation.
- **"What Are Your Moves Tomorrow"** — historically the evening counterpart to the Daily thread.
  `[uncertain]` not confirmed live under that exact name on 2026-06-03 (only the daytime Daily
  Discussion + Weekly Earnings were stickied). Verify before depending on it.
- **Weekly Earnings Thread** — mod-posted, currently framed weekly (e.g. "Weekly Earnings Thread
  6/1 – 6/5"), not per-event. Catalyst calendar anchor.
- Source: live front page <https://old.reddit.com/r/wallstreetbets/>.

## 6. Rules that shape the data (read before designing extraction)

Full rules: <https://old.reddit.com/r/wallstreetbets/about/rules/>. The ones that affect signals:

- **Rule 3 — Market cap > $500MM.** A bot auto-removes ("spams") tickers below the floor, and
  **re-bans them once they fall under $400MM** (hysteresis band). ⇒ The ticker universe visible on
  WSB is **already filtered to ~$500MM+ names**; sub-$500MM mentions get scrubbed, so their
  absence in the data is a moderation artifact, not lack of interest. This conveniently bounds the
  market-data universe you need.
- **Rule 5 — YOLO ≥ $10k options / $25k shares**, with a position screenshot.
- **Rule 6/7 — Gain/Loss ≥ $2.5k options / $5k shares, realized.** Position screenshot required;
  *"if you have to say 'position in comments', you're doing it wrong"* — **the first image must be
  the positions/P&L screen.** ⇒ Direction & size are often only in an **image**, not text (OCR or a
  vision model needed to extract them reliably).
- **Rule 8 — Only BTC & ETH crypto** (the two with CME futures).
- **Rule 9 — No pump & dumps / short squeezes / manipulation.** Coordinated gamma-squeeze
  instigation ("buy calls so market makers delta-hedge") is explicitly banned. ⇒ Overt
  manipulation is moderated *down*, but the underlying behavior is the whole point of the sub —
  treat WSB as a **potentially manipulated / reflexive signal**, not a neutral sentiment gauge.
- **Account age/karma minimums** are dynamic (bot-load dependent), no fixed public number.
- There is **no static banned-ticker list** — it's the rule-based market-cap/penny-stock filter,
  applied dynamically by bot.

## 7. Ticker-extraction conventions (critical for the parser)

- **Tickers are usually written BARE and uppercase** (`GME`, `SPY`, `MU`, `MRVL`) — **not** as
  `$`-prefixed "cashtags" like StockTwits/Twitter. Both forms occur; bare dominates.
- A naïve `\$?[A-Z]{1,5}` regex will catch tickers **and** a flood of false positives (`CEO`,
  `YOLO`, `FD`, `IMO`, `USA`, `IT`, `A`, `DD`, `WSB`…). You **must** validate against a
  **reference symbol list** and a **WSB slang/abbreviation stoplist**, and ideally weight by
  whether the token co-occurs with trading words (calls/puts/$/strike/expiry).
- `$`-prefixed tokens are higher-precision when present — treat `$AAPL` as a strong ticker signal.
- **Automod is pervasive:** the Daily thread is bot-posted; the market-cap bot removes/restores
  tickers; flair bots remove mislabeled posts. Expect bot-authored content in the stream
  (filter by known bot accounts: `wsbapp`, `AutoModerator`, `VisualMod`, etc.).

## 8. Biases to design around (these are correctness issues, not footnotes)

- **Survivorship / selection bias in Gain posts:** winners post screenshots; most losers stay
  quiet (or post ironically). Raw "gain post" counts **overstate** bullish success. Pair Gain with
  Loss flair and with *volume of bets placed* (YOLO/DD), not just outcomes.
- **Reflexivity / manipulation:** WSB *moves* the small/mid names it discusses; a "signal" can be
  the cause, not a leading indicator. Correlation with price/volume may be **contemporaneous or
  lagging**, and can be **self-fulfilling then mean-reverting** (pump-and-dump shape).
- **Contrarian regimes:** peak euphoria on a ticker has historically marked local *tops* as often
  as continuation. The sign of the correlation is an empirical question per regime, not a given.
- **Bot & brigade noise**, **karma farming**, and **paid-promo leakage** (despite Rule 13) all
  contaminate raw counts.
- ⇒ **The honest framing of this project is *observational/correlational research*, not a
  validated alpha source.** Build it to *measure* the lead/lag relationship, with these biases as
  first-class confounders — not to assume WSB predicts the market.

## 9. Discord servers — official vs unofficial

**"Official" = endorsed by the subreddit moderators.** The only objective test is the
**moderator-maintained subreddit sidebar**, which links exactly one Discord.

> **OFFICIAL: `https://discord.gg/wsbverse`** — the *only* server linked from the WSB sidebar
> ("Join the discord → WSB Discord"). Source:
> <https://old.reddit.com/r/wallstreetbets/wiki/config/sidebar>

| Invite | Guild name | Created | Members (2026-06-03) | Status | Notes |
|---|---|---|---|---|---|
| **discord.gg/wsbverse** | "WallStreetBets" | 2022-11-03 | ~176k | **OFFICIAL** | Only sidebar-linked server. Gated (see below). |
| discord.gg/wallstreetbets | "Official  wallstreetbets" | 2020-06-25 | ~466k | **UNOFFICIAL** | Largest; self-labels "Official"/"Original" but **not** sidebar-linked; sells **paid memberships** (contradicts WSB Rule 13). Operator unverified `[uncertain]`. |
| discord.gg/wsb | "OG wallstreetbets" | 2020-12-18 | ~65k | **UNOFFICIAL** | Independent trading server; "net-worth roles", ticker bots. |

Counts via the live Discord API (`/api/v9/invites/<code>?with_counts=true`) — the authoritative
source for server data (aggregator listings are stale/inflated).

> ⚠️ **The naming is deliberately confusing.** The *biggest* server brands itself "Official" /
> "Original Discord of /r/wallstreetbets" but is **not** the one the subreddit endorses. A guild
> having "Official" in its name is **not** evidence of endorsement — only the sidebar is. If you
> ingest Discord, decide explicitly *which* server you mean and why.

### History — the 2021 ban
- **2021-01-27:** Discord banned the then-official WSB server for **hate speech** ("hateful and
  discriminatory content"), explicitly **not** for GameStop/finance.
- **2021-01-28:** Discord reversed course, helped WSB **stand up a new server** (~296k members at
  the time) and provided moderation support.
- The current official **wsbverse** guild was **created 2022-11-03**, ~21 months later — i.e. a
  *later* re-founding, not the literal Jan-2021 rebuild. Sources: The Verge
  <https://www.theverge.com/2021/1/28/22254339/discord-r-wallstreetbets-server-help-moderation-ban>,
  Wikipedia.

### Access & feasibility (read before scoping Discord ingestion)
- **wsbverse is publicly joinable but gated:** member-verification gate (must accept rules),
  Discord onboarding flow, and **verification level 3 ("High")** — an account must exist >10 min
  to chat. Source: live Discord API feature flags.
- **There is no official, ToS-compliant read API for arbitrary server message history.** Discord's
  official API requires a **bot invited by a server admin** (you won't get that for wsbverse), and
  **user-token "self-bot" scraping violates Discord's ToS** and risks an account ban. This makes
  Discord a **materially harder and riskier data source than Reddit** — there is no PullPush/
  Arctic-Shift equivalent. **Recommendation: treat Discord as a Phase-2+ pluggable source; build
  v0.0.1 on Reddit, which has clean, ToS-friendly historical APIs.** (See the interview/README.)

## 10. Implications for WSB Signals (summary)

1. **Read comments, not just posts** — the Daily Discussion Thread is where most ticker chatter
   lives.
2. **Flair is a high-quality label** — segment empirical signals by DD / YOLO / Gain / Loss / News.
3. **Tickers are bare uppercase** — parser needs a symbol whitelist + slang stoplist + trading-word
   weighting.
4. **Position size/direction is often in images** — full extraction may need OCR / a vision model;
   v0.0.1 can start text-only and treat images as a later enrichment.
5. **The universe is pre-filtered to ~$500MM+ names** — bounds the market-data side.
6. **Bias is the core scientific risk** — survivorship, reflexivity, manipulation, bots. Design to
   *measure* lead/lag, not to assume predictive power.
7. **Reddit first, Discord later** — Discord has no clean API and real ToS risk.

## Sources
Subreddit (live, via `old.reddit.com`): front page · `/about/rules/` · `/wiki/contentguide` ·
`/wiki/linkflair` · `/wiki/config/sidebar` · `/wiki/faq`.
Encyclopedic: <https://en.wikipedia.org/wiki/R/wallstreetbets>.
Discord: live API `/api/v9/invites/<code>?with_counts=true` for wsbverse / wallstreetbets / wsb.
2021 ban: The Verge, Reuters, Engadget, TechTimes, Shacknews (2021-01-27/28).
