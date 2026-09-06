# Model catalog — providers, parameters, pricing (SINGLE SOURCE OF TRUTH)

**Status: catalog reference reconciled with `main` on 2026-08-18.** This is THE one document that answers
"which provider serves this model, with what parameters, at what cost, and how
do we know". All older pricing/provider docs were folded into this file and
deleted (see §9). For finance: §3–§5 carry per-SKU COGS on BOTH routes with a
provenance tag on every number (owner list = the owner's provider price
screens, PAID = a real money call through our keys).

The generated `cost-legs` catalogue and migrations on `main` are the current
numeric/runtime source for pricing and routing. This document remains the
capability, provider, parameter, and evidence reference. The current-state
implementation note is `docs/business/pricing-implementation-plan-2026-07-28.md`;
it records which production gates are still outstanding.

Machine-readable truth (checked by CI, wins over this file on any conflict):

- `packages/db/seed/models.ts` — the catalog rows (sold params, токены, routing).
- `packages/providers/byteplus/src/kie-adapter.ts` `MODEL_SLUGS` — our id → kie slug.
- `packages/shared/src/model-contract-byteplus.ts` — gateway contract registry;
  `docs/platform/model-gateway-contract-matrix.md` is GENERATED from it (do not hand-edit).
- `packages/shared/src/assist-tiers.ts` — text tiers + per-1M-token prices.

When you change a model, a route, or a price: change the code, then update THIS
file in the same commit. No new per-topic pricing docs — extend this one.

## Source precedence — ONE rate, everywhere (owner ruling 2026-08-03)

A vendor rate now lives in exactly one place and is copied, never re-derived.
When two documents disagree, resolve **in this order and fix the loser in the
same change** — do not "reconcile" by averaging, rounding, or picking the newer file.

1. **An owner-supplied vendor screen** (a pasted vendor pricing page or dashboard).
   This beats everything, including a PAID call, because it is the vendor's own
   published number for the SKU we buy.
2. **A PAID call through our keys** — authoritative for what we were actually charged.
3. **This file.**
4. **The finance workbook** «НОГИ (экспорт)» / «Сетка FX».
5. Anything else — a vendor doc, a blog, a relay's marketing page. Never a routing input on its own.

Two rules that follow, and both have already been broken once:

- **Copy the vendor's decimals exactly.** `$0.06726` is not `$0.067`. Rounding at
  entry is how the same rate ends up as three different numbers in three files.
- **A price and a relay travel together.** A rate carries the name of the vendor
  that quoted it. Three separate defects in the 2026-08-03 workbook were a real
  price under the wrong relay name, which inverts cheapest-first routing and
  calls the wrong vendor.

Finance does not hold rates independently — they consume this file. If the
workbook needs a rate this file does not have, the gap is filled **here first**.

**Breaking API change (2026-07-28):** `POST /v1/jobs` and `POST /v1/jobs/estimate`
now reject a video request that omits `resolution` for any model declaring a
non-empty `capabilities.resolutions`, with stable code `resolution_required`.
Models declaring `resolutions: []` (Gemini Omni) are unaffected. This is a
deliberate breaking change for direct API clients; it is accepted because none exist.

---

## 1. How routing works (60 seconds)

A catalog row picks its vendor through three fields (see seed/models.ts):

- `capabilities.forceGateway` — pins a gateway/chain (`openrouter`, `kie`,
  `nanobanana` = laozhang→kie chain, `geminiomni` = kie→AtlasCloud chain).
- `gatewayOverride` (column) — admin/seed override, beats slug-shape inference
  (a slash `providerModelId` would otherwise imply OpenRouter).
- `fallbackGateway` (column) — availability fallback: on a PRIMARY SUBMIT failure
  the job reruns on the fallback leg (CircuitBreakerAdapter). A failure AFTER a
  successful submit refunds — it does NOT re-run (no double-charge).

**Seed caveat:** reseeds COALESCE `gatewayOverride`/`fallbackGateway` — existing
DB rows KEEP old routing. Fresh deploys get seed values; existing DBs need an
admin PATCH or SQL update. (Fixed 2026-07-25: dev DB seedance rows carried a
pre-merge `atlascloud` fallback after the seed moved them to `kie`; prod was
healed by the 2026-07-25 reseed, dev by SQL.)

Fallbacks are deliberately ABSENT where the fallback would lose money
(veo/grok on OpenRouter) or does not exist (kling, flux, recraft, happyhorse-1.0).
An outage there fails the job — accepted risk, not a bug.

## 2. Gateways

| Gateway      | What it is                                                                                             | Auth env             |
| ------------ | ------------------------------------------------------------------------------------------------------ | -------------------- |
| `openrouter` | OpenRouter aggregator (slash slugs)                                                                    | `OPENROUTER_API_KEY` |
| `kie`        | kie.ai market `createTask/recordInfo` + dedicated paths (`/veo/*`, `/gemini-3-flash/v1`, `/claude/v1`) | `KIE_API_KEY`        |
| `laozhang`   | laozhang.ai (OpenAI-shaped, nano-banana/gpt-image primary)                                             | `LAOZHANG_API_KEY`   |
| `atlascloud` | AtlasCloud (seedream/seedance/omni fallback leg)                                                       | `ATLASCLOUD_API_KEY` |
| `nanobanana` | chain: laozhang primary → kie fallback (inline result, no stuck jobs)                                  | both                 |
| `geminiomni` | chain: kie primary → AtlasCloud fallback                                                               | both                 |
| `gptproto`   | gptproto.com Gemini-image relay (`/api/v3/google/{model}/{scene}` + predictions poll)                  | `GPTPROTO_API_KEY`   |

**kie video billing rule (owner list 2026-07-25):** models _with video input_
bill `unit price × (input + output) duration` at a LOWER unit rate; models
without video input bill `unit price × output duration`. The with-video rates
below are the lower per-second numbers applied to the summed duration.

---

## 3. Video models (active)

COGS = what WE pay per leg, per SECOND unless noted. The user-facing unit is
**токены**; each entry below is the active price-point rung, anchored at its stated
base duration.

| Model                                | Sold params                                                   | Primary (COGS/s)                                                                                                                                                                                                                                                                           | Fallback (COGS/s)                                                                                                                                                                                       | ACTIVE токены                                                                                                                                                                                                                                             | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| seedance-2-0                         | t2v, 480p/720p/1080p/4K, 4–15s, audio, first+last frames      | OpenRouter `bytedance/seedance-2.0` **per s, audio and no-audio IDENTICAL**: 480p $0.06726 / 720p $0.1512 / 1080p $0.3402 / **4K $1.361**                                                                                                                                                  | kie `bytedance/seedance-2`: 480p $0.095 / 720p $0.205 / 1080p $0.51 / **4K $1.04**                                                                                                                      | 480p **145**/5s; 720p **323**/5s; 1080p **775**/5s (480p/720p rev9 2026-08-05; 1080p re-signed rev12 2026-08-09); 4K 2183/5s (4K `isActive:false`)                                                                                                        | **OWNER SPEC 2026-08-03 — exact decimals, supersedes all rounded copies.** OR PAID 2026-06/07; kie 480p PAID task `c9dec662` ($0.38/4s = $0.095/s ✓)                                                                                                                                                                                                                                                                                                                                                                                              |
| seedance-2-0-fast                    | 480p/720p (catalog cap — kie fast has no 1080p either), 4–15s | OpenRouter: 480p $0.0538 / 720p $0.121 (1080p $0.272 / 4K $1.089 not sold)                                                                                                                                                                                                                 | kie `bytedance/seedance-2-fast`: 480p $0.0775 / 720p $0.165                                                                                                                                             | 480p **118**/5s; 720p 259/5s (480p re-signed rev9 2026-08-05)                                                                                                                                                                                             | kie 480p PAID task `18d5d9a8` ($0.31/4s ✓); kie ladder owner list 2026-07-25                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| seedance-2-0-reference-to-video      | + image≤9, audio≤3; video refs disabled                       | OpenRouter: output-billed at the t2v ladder ($0.067/0.151/0.340 per output s)                                                                                                                                                                                                              | kie WITH-VIDEO rates: 480p $0.057 / 720p $0.125 / 1080p $0.31 per (input+output) s                                                                                                                      | image-only: 480p **145**/5s; 720p **323**/5s; 1080p **775**/5s (rev9 2026-08-05; 1080p held at the t2v twin per owner ruling 5 — the rev12 export still exports 776, correction requested for rev13)                                                      | image-only mirrors t2v; with-video rows are inactive (listed below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| seedance-2-0-fast-reference-to-video | + image≤9, audio≤3; video refs disabled                       | OpenRouter: output-billed ($0.0538/0.121 per output s)                                                                                                                                                                                                                                     | kie WITH-VIDEO rates: 480p $0.045 / 720p $0.10 per (input+output) s                                                                                                                                     | image-only: 480p **118**/5s; 720p 259/5s (rev9 2026-08-05)                                                                                                                                                                                                | image-only mirrors t2v; with-video rows are inactive (listed below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| veo-3-1 (Quality)                    | t2v+i2v, 720p/1080p, 4/6/8s, audio, first+last frames         | kie `veo3` FLAT per video: 720p $1.25 / 1080p $1.275 (4K $1.85 not sold) ≈ $0.32/s worst (4s)                                                                                                                                                                                              | none (OR $0.40/s audio / $0.20 no-audio @1080p = loss; OR 4K $0.60/$0.40 — owner OR specs 2026-07-25, kept as the 0.40 ppu basis)                                                                       | 720p/1080p: **597 flat per clip** (rev9 2026-08-05 — Veo moved to flat-rate; the old 895/913 «per 8s» predates it)                                                                                                                                        | kie slug smoke + owner dashboard 2026-07-20; full 29-row kie table owner list 2026-07-25                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| veo-3-1-fast                         | same shape                                                    | kie `veo3_fast` FLAT per video: 720p $0.30 / 1080p $0.325 (4K $0.90 not sold) ≈ $0.081/s worst                                                                                                                                                                                             | none                                                                                                                                                                                                    | 720p **122** / 1080p **132**, flat per clip (rev9 2026-08-05)                                                                                                                                                                                             | kie PAID task `6a30969a`; table owner list 2026-07-25                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| veo-3-1-lite                         | same shape                                                    | kie `veo3_lite` FLAT per video: 720p $0.15 / 1080p $0.175 (4K $0.75 not sold) ≈ $0.044/s worst                                                                                                                                                                                             | none                                                                                                                                                                                                    | 720p **66** / 1080p **71**, flat per clip (rev9 2026-08-05)                                                                                                                                                                                               | kie PAID task `e0958fba`; table owner list 2026-07-25                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| grok-imagine-video                   | t2v · i2v, 480p/720p (HARD cap — 1080p → 422), 6s             | kie `grok-imagine/text-to-video`: 480p $0.012 / 720p $0.0225 per s (i2v same rates — finance rev. 11, Сетка FX стр.102/103; the $0.008/$0.015 recorded here until 2026-08-08 was 47% under the live card, and R-8 re-checks it every 14 days because kie moved this rate 50% in two weeks) | none (Atlas probe existed, not wired)                                                                                                                                                                   | 480p 37/6s; 720p 69/6s                                                                                                                                                                                                                                    | exact per-resolution rates owner list 2026-07-25                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| wan-2-7                              | **t2v · i2v**, 720p/1080p, 4–10s                              | kie `wan/2-7-text-to-video` + `wan/2-7-image-to-video` $0.08/$0.12 per s (i2v slug wired 2026-08-11; PAID CALL 2026-08-11 task `d1f623742cc98f2af897ab45048eb63d`, $0.40 for 5s@720p = $0.0800/s, rate confirmed to the cent)                                                              | OpenRouter `alibaba/wan-2.7` $0.10/$0.15 per s                                                                                                                                                          | t2v 163/244 per 5s; **i2v 163/244 per 5s** — rev.21 repriced i2v onto the kie leg (−24%), so both modes now sell at the same price off the same leg                                                                                                       | kie PAID (r08, 1080p OK 72 токена vs 48 @720p)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| happyhorse-1-1                       | **t2v · i2v · r2v**, 720p/1080p, 4/6/8/10s, audio out (1.1)   | OpenRouter `alibaba/happyhorse-1.1`: 720p $0.0988 / 1080p $0.1278 per s — **cheapest leg, all three modes**                                                                                                                                                                                | kie `happyhorse-1-1/{text,image,reference}-to-video`, **all three modes at one rate**: 720p 22.5 tok/s = **$0.1125**, 1080p 29 tok/s = **$0.145** (kie token = **$0.005**, owner dashboard 2026-08-03)  | 720p **212**/5s; 1080p 274/5s (720p re-signed rev9 2026-08-05)                                                                                                                                                                                            | **OWNER SPEC 2026-08-03 — kie $ now converted, the "unconverted" note is closed.** isolated first-frame i2v PAID (`n0Npq5mGx…`)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| happyhorse-1-0                       | **t2v · i2v · r2v · video-edit**, 720p/1080p, 4/6/8/10s       | OpenRouter `alibaba/happyhorse-1.0`: 720p **$0.0988** / 1080p **$0.1694** per s — **cheapest leg at both rungs**                                                                                                                                                                           | kie `happyhorse/{text,image,reference}-to-video` + `video-edit`, **all four modes at one rate**: 720p 28 tok/s = **$0.14**, 1080p 48 tok/s = **$0.24**. DISPUTE CLOSED — kie publishes it and prices it | 720p 284/5s; 1080p 365/5s                                                                                                                                                                                                                                 | **OWNER SPEC 2026-08-03 — 720p OR rate recorded for the first time; the 404 note is retired.** i2v PAID (`M-NUY6r_nQ…`)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| kling-v3-0-std                       | first/last-frame i2v, 720p, 5/10s                             | OpenRouter `kwaivgi/kling-v3.0-std` $0.126/s audio / $0.084/s no-audio                                                                                                                                                                                                                     | none exists                                                                                                                                                                                             | 720p 270/5s звук, 180/5s без звука                                                                                                                                                                                                                        | contract + isolated first-frame i2v PAID 2026-07-26 (`EkoHKKax2CTo0CbG5j00O`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| gemini-omni-flash                    | t2v(+i2v on ref), 4/6/8/10s, 16:9/9:16                        | kie `gemini-omni-video` $0.063–0.079/s flat 720p=1080p (63 kie-токена) — PAID 2026-07-25 (task 895572f1, 720p 4s h264+aac)                                                                                                                                                                 | AtlasCloud `google/gemini-omni-flash/*-developer` $0.112/s — PAID, real generation                                                                                                                      | default **273**/8s (rev12:Сетка FX стр.30, 2026-08-09). History worth keeping: this cell read 273, rev9 took it DOWN to 257, and rev12 put it back at 273 — so a bare "273" in an old doc is not evidence of anything. Cite the revision, not the number. | AtlasCloud was loss-making at 257 (−5.96%) and R-1 forbade signing it; **rev12 raised the price to 273 specifically to make it signable** and the leg is now costed in cost-legs.csv at +0.25%. Thin by design, not by accident. The $0.112 is the **t2v/i2v** route; `reference-to-video` is a different Atlas route at $0.135 and must not be read across — that confusion is what made 2026-08-03 report this rate as stale. **Signed is not reachable:** no AtlasCloud leg is wired in `model-contract-byteplus.ts`, so the reserve is inert. |

**Inactive (not chargeable):** Seedance 2.0 4K is `2183/5s`, but the catalog does
not declare 4K. The six with-video rows are also inactive because input duration is
not attestable: Seedance 2.0 r2v 4K `242/1s`, 1080p `117/1s`, 720p `47/1s`, 480p
`22/1s`; Seedance Fast r2v 720p `34/1s`, 480p `15/1s`. These configurations refuse;
they are not fallback prices.

**Veo billing gotcha:** kie charges FLAT PER VIDEO, we bill per SECOND. Worst
case is the shortest clip: 4s Quality 1080p = $1.275/4 ≈ $0.319/s < $0.40 ppu
✓ covered, but watch it if durations below 4s are ever offered.

**kie veo extras (owner list 2026-07-25, not sold today):** reference-to-video
Lite 720p/1080p/4K = $0.15/$0.175/$0.75, Fast = $0.30/$0.325/$0.90 per video;
Extend Lite $0.15 / Fast $0.30 / Quality $1.25 per video; Get-1080p $0.025,
Get-4K $0.60. grok-imagine/extend: 6s $0.05 (480p) / $0.10 (720p), 10s
$0.10/$0.15; grok-imagine upscale 360p→720p $0.05; grok-imagine images
$0.02/img (t2i 6-pack, i2i single).

## 4. Image models (active)

COGS per IMAGE unless noted. Цены для пользователя — токены за изображение.

| Model                                            | Sold params                                                                                                                                                                        | Primary (COGS)                                                                                                        | Fallback (COGS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ACTIVE токены                                                                                                                                                                                                                                                                                                          | Verified                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| seedream-4-5                                     | 2K/4K, ratios, edit refs; 1K parked because kie has no 1K tier                                                                                                                     | kie `seedream/4.5-{text-to-image,edit}` $0.0325/img t2i+i2i — primary 2026-07-28                                      | OpenRouter `bytedance-seed/seedream-4.5` $0.04/img fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2K/4K: 17 / 20 токенов                                                                                                                                                                                                                                                                                                 | kie basic=2K and high=4K ✓                                                        |
| gemini-2.5-flash-image (nano-banana)             | ratios, ≤3 refs (edit slug)                                                                                                                                                        | laozhang $0.02/img                                                                                                    | kie `google/nano-banana` $0.02/img t2i / $0.02 edit (owner list 2026-07-25)                                                                                                                                                                                                                                                                                                                                                                                                                                                       | default: 9                                                                                                                                                                                                                                                                                                             | laozhang PAID                                                                     |
| gemini-3-pro-image (nano-banana-pro)             | 1K/2K/4K, ratios, ≤8 refs                                                                                                                                                          | laozhang $0.09/img flat                                                                                               | kie `nano-banana-pro` $0.09 (1K/2K) / $0.12 (4K) — PAID 2026-07-02                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 1K/2K/4K: 37 / 43 / 50 токенов                                                                                                                                                                                                                                                                                         | laozhang PAID                                                                     |
| gemini-3-1-flash-image (nano-banana-2)           | 1K/2K/4K, ratios, ≤3 refs                                                                                                                                                          | laozhang $0.055/img flat                                                                                              | kie `nano-banana-2` PER RUNG: 1K $0.04 / 2K $0.06 / 4K $0.09 (kie pricing page 2026-08-03 — the old flat $0.04 was the 1K figure only)                                                                                                                                                                                                                                                                                                                                                                                            | 1K/2K/4K: **17 / 23 / 28** токена (rev9 2026-08-05)                                                                                                                                                                                                                                                                    | laozhang PAID                                                                     |
| gemini-3-1-flash-lite-image (nano-banana-2-lite) | ratios, ≤10 refs (kie doc 2026-07-24), 1K fixed                                                                                                                                    | laozhang $0.025/img (kept conservative)                                                                               | kie `nano-banana-2-lite` $0.02/img (owner-confirmed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | default: **9** (rev9 2026-08-05)                                                                                                                                                                                                                                                                                       | kie price confirmed by owner + PAID 2026-07-25 (task ef9b7673)                    |
| gpt-image-2                                      | ≤8 refs on both legs; LaoZhang exposes vendor quality `low` / `medium` / `high`; Kie fallback exposes resolution `1K` / `2K` / `4K` only and is costed but unarmed pending mapping | laozhang $0.03–0.05/img (C2PA-verified)                                                                               | kie `gpt-image-2-{text,image}-to-image` $0.03/0.05/0.08 by the signed low/medium/high cost rows; runtime fallback is intentionally not armed until quality→resolution mapping is approved                                                                                                                                                                                                                                                                                                                                         | 13 / 21 / 33 токены                                                                                                                                                                                                                                                                                                    | laozhang PAID 2026-07-20; Kie cost list owner-confirmed 2026-07-25                |
| seedream-5-0-pro                                 | 1K/2K (quality basic/high, NO 4K), 8 ratios, ≤10 refs                                                                                                                              | kie `seedream/5-pro-{text,image}-to-image` $0.035 1K / $0.07 2K (i2i same; input images $0.0025 each, first one free) | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 1K: 16; 2K: **31** (rev9 2026-08-05); refs 2–10 bands 1K **24** / 2K **38** (rev10)                                                                                                                                                                                                                                    | owner list 2026-07-24, re-confirmed by the 2026-07-25 table; prod LIVE 2026-07-25 |
| seedream-5-0-lite                                | 2K/3K/4K (quality basic/high/ultra), 8 ratios, ≤10 refs                                                                                                                            | kie `seedream/5-lite-{text,image}-to-image` $0.0275/img FLAT any quality                                              | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2K/3K/4K: 12 / 14 / 17 токенов                                                                                                                                                                                                                                                                                         | PAID 2026-07-25 (task 45659930, 3:4 basic → 1680x2240 png)                        |
| flux-2-pro                                       | 1K/2K, 7 ratios, ≤8 refs (kie primary since rev. 14)                                                                                                                               | OpenRouter `black-forest-labs/flux.2-pro` $0.03 per picture (owner-verified 2026-07-28)                               | kie `flux-2/pro-{text,image}-to-image` 1K $0.025, **2K $0.035 MEASURED 2026-08-09** (7 kie credits @ $0.005, calibrated off the signed 1K leg; delivers 1536², i.e. 2.25× pixels for 1.40× cost — BFL's $0.03/MP model overshoots ~3.4×). Since rev. 14 kie is the PRIMARY route and the adapter reads the caller's rung instead of the `1K` it used to pin; OpenRouter is the reserve and is sent NO rung at all, because it bills per MEGAPIXEL on a route that declares no size control. kie's enum stops at 2K — no 4K exists | 1K (0–1 refs): **11**; 1K refs 2–8 band: **14** (rev13 — was 13; OpenRouter bills $0.03 per MEGAPIXEL and a 1K image is 1.049 MP, so the leg always cost $0.0315 and 13 was 22.4%, under the floor); 2K: **15** (rev13, ACTIVE since rev. 14, which re-banded the cheap rung `default`→`1K` so both could be declared) | owner-verified 2026-07-28; kie leg fix 2026-08-09 (input_urls array, kie-specs)   |
| recraft-v4                                       | ≤1 ref on the OR route (native API allows 5 — OR catalog limit, accepted)                                                                                                          | OpenRouter $0.04/img                                                                                                  | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | default: 18                                                                                                                                                                                                                                                                                                            | contract-verified                                                                 |
| recraft-v4-vector                                | —                                                                                                                                                                                  | OpenRouter $0.08/img                                                                                                  | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | default: 35                                                                                                                                                                                                                                                                                                            | contract-verified                                                                 |

**Other recraft SKUs on OpenRouter (owner specs 2026-07-25, not sold):**
recraft 4.1 $0.035, v4 pro $0.25, pro vector $0.30, 4.1 pro $0.21 per image.
**kie flux (not wired):** flux-2 flex 1K $0.07 / 2K $0.12; flux1-kontext pro
$0.025 / max $0.05 per image.

The active rungs above are the complete v14 ladder. A request without an active
matching row is refused; there is no rollout exception or alternate price.

## 5. Text / LLM (assist «Сценарий», structurize, enhancer)

Prices = USD per 1M tokens (input/output). User tokens derive fail-closed from the
OpenRouter price even when kie is primary (conservative guardrail basis —
`assist-tiers.ts`); kie savings are pure margin.

Margin policy is surface-specific and comes from the workbook: Boards and media
keep the global 25% floor. Active paid Scenario assist context bands and
Structurize use the active **25% no-cache floor**; the older flat Scenario rows
retain the temporary 7% policy only for historical replay/import compatibility.
Free background compaction has no customer-facing margin and remains a spend
ceiling only.

| Surface                                | Model                         | Primary (COGS)                                                                       | Fallback (COGS)                                                                             | Verified                                                                                                                                                        |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tier Экономный                         | qwen/qwen3.5-plus-02-15       | OpenRouter $0.26/$1.56                                                               | none                                                                                        | OR live                                                                                                                                                         |
| Tier Стандарт                          | google/gemini-3-flash-preview | **kie** `/gemini-3-flash/v1/chat/completions` $0.15/$0.90                            | OpenRouter $0.50/$3.00                                                                      | kie leg PAID live 2026-07-25 — SSE clean, `max_tokens` accepted                                                                                                 |
| Tier Максимум                          | anthropic/claude-sonnet-5     | **kie** `/claude/v1/messages` $0.85/$4.275 (Anthropic SSE)                           | OpenRouter $2.00/$10.00                                                                     | kie leg PAID live 2026-07-25 — Anthropic SSE clean, top-level `system` accepted                                                                                 |
| Structurize (S1)                       | deepseek/deepseek-v4-flash    | OpenRouter $0.09/$0.18                                                               | none                                                                                        | OR live; active Scenario 25% no-cache floor (legacy 7% row is replay/import-only)                                                                               |
| Scene-object extraction (free)         | deepseek/deepseek-v4-flash    | OpenRouter $0.09/$0.18; `OPENROUTER_API_KEY`                                         | none                                                                                        | Free to user; internal worst-case ceiling is 68,000 UTF-8 input bytes + 800 output tokens = 3 credits                                                           |
| Prompt enhancer / Director             | openai/gpt-4o-mini            | OpenRouter $0.15/$0.60                                                               | none                                                                                        | OpenRouter model page verified 2026-07-26                                                                                                                       |
| Boards Prompt Studio «Claude Sonnet 5» | anthropic/claude-sonnet-5     | **kie** `/claude/v1/messages` $0.850/$4.275                                          | OpenRouter $2.00/$10.00; cache read $0.20, write $2.50 ($4.00/1h)                           | selector `claude`; **6 токенов** for a successful ready prompt; 1,000-char brief/result; 2,400-in / 400-out request cap; derived from Kie + fallback worst case |
| Boards Prompt Studio «GPT-5.6 Terra»   | openai/gpt-5.6-terra          | **kie** `/codex/v1/responses` $0.700/$4.200; cached input $0.070, cache write $0.875 | OpenRouter <=272K $2.50/$15.00, >272K $5/$22.50; cache read $0.25/$0.50, write $3.125/$6.25 | selector `gpt`; **7 токенов** for a successful ready prompt; 1,000-char brief/result; 2,400-in / 400-out request cap; derived from Kie + fallback worst case    |
| Boards Prompt Studio «Gemini 3 Flash»  | google/gemini-3-flash-preview | **kie** `/gemini-3-flash/v1/chat/completions` $0.150/$0.900                          | OpenRouter $0.50/$3.00                                                                      | selector `gemini`; **2 токена** for a successful ready prompt; 1,000-char brief/result; 2,400-in / 400-out request cap; derived from Kie + fallback worst case  |

Routing: `apps/api/src/script-assist.ts` `KIE_LEGS` (slug → kie leg); fallback
to OpenRouter only BEFORE the first content delta. Kill-switch
`KIE_CHAT_DISABLED=1`. Metric `seed_scenario_assist_text_route_total{leg,outcome}`.
Admin: `GET /v1/admin/provider-balances` → `textModels` (route + prices +
on/off state from `assist_tier_states`, toggled via `PATCH /v1/admin/text-tiers/:id`;
a disabled tier fails closed with 409 `tier_disabled` before any token hold).

**Prompt Studio routing and billing contract:** Kie is primary for all three selectors and OpenRouter is
only a pre-result fallback, so a provider failure never becomes a synthetic live
result. The selector price (Gemini 2 токена, Claude 6 токенов, Terra 7 токенов) is derived
from the fallback max-envelope COGS and reserved before egress; it is committed only
after a valid prompt and every unsuccessful path refunds it. The user-facing brief and
ready result are each capped at 1,000 characters (the Runway Gen-4 published prompt
field baseline). The API counts instruction + idea + reference context against a hard
2,400-token serialized-request envelope and limits provider output to 400 tokens; the
larger token budget pays for our structured canvas metadata and is not a recommendation
to write 2,400-token visual prompts.

**Scene-object extraction pricing and spend contract:** `POST
/v1/boards/:boardId/scenes/:nodeId/objects` is free to the user and calls
OpenRouter with `deepseek/deepseek-v4-flash`, with reasoning disabled, a hard
68,000-byte UTF-8 input envelope, and `max_tokens: 800`. Its worst-case internal
reservation is 3 credits, derived from the model price and that envelope; long
UTF-8 scenes are safely prefix-truncated and the response reports
`sourceTruncated: true`. Before the provider call it atomically reserves 3
credits in both the global `seed:spend:daily:<UTC-day>` bucket governed by
`DAILY_SPEND_CAP_CREDITS` and the dedicated
`seed:spend:daily:scene-objects:<UTC-day>` bucket governed by
`SCENE_OBJECTS_DAILY_SPEND_CAP_CREDITS`. The dedicated value has no default and
is fail-closed when unset; operators must set it materially below the global
cap. If the dedicated reservation fails, the global reservation is released.
Provider-started failures retain both reservations and place the idempotency key
in a short cooldown; completed results retain the replay key for 30 days.

**Unused kie chat prices (owner list 2026-07-24, available if we add tiers):**
Gemini 3.5 Flash $0.45/$2.70, 3.6 Flash $0.45/$2.25, 3 Pro / 3.1 Pro
$0.50/$3.50, 2.5 Flash $0.09/$0.75, 2.5 Pro $0.38/$3.00. grok chat (owner list
2026-07-25): grok-4-5 $0.80 in / $2.40 out / $0.20 cached; grok-4-3 $0.50 /
$1.00 / $0.08 per 1M.

## 6. Inactive / parked rows

| Row                  | State                                                                                                                     | Prices on record (not sold)                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| happyhorse-1-1-kie   | DELETED 2026-07-25 (owner decision — main `happyhorse-1-1` row routes kie; standalone dup removed from seed + prod + dev) | —                                                                                                                              |
| happyhorse-1-0-kie   | DISPUTED — kie docs publish 3 unversioned happyhorse routes (2026-08-03); re-test                                         | dead — kept off                                                                                                                |
| sora-2-pro           | owner dropped 2026-07-16                                                                                                  | OR $0.50/s @1080p (real paid call); 720p list $0.30/s                                                                          |
| seedance-1.5-pro     | parked (superseded by 2.0)                                                                                                | kie: 480p $0.00875 / 720p $0.0175 / 1080p $0.0375 no-audio; with audio $0.0175 / $0.035 / $0.075 per s (owner list 2026-07-25) |
| seedance-2-mini      | deliberately excluded — see §8                                                                                            | kie: 480p $0.0475 / 720p $0.1025 no-video; with-video $0.03 / $0.0625 per s (owner list 2026-07-25)                            |
| seedance-1.x (other) | superseded by 2.0                                                                                                         | —                                                                                                                              |
| seedream-3-0         | superseded                                                                                                                | —                                                                                                                              |
| doubao-tts-zh        | voice, parked                                                                                                             | —                                                                                                                              |

## 7. Verification ledger (what "verified" means here)

- **PAID** = a real money call through OUR keys returned a real asset: kie route
  tests 2026-07-16/19/20 (task ids in §3), laozhang gpt-image-2 C2PA 2026-07-20,
  OR seedance/seedream/happyhorse 2026-06/07, AtlasCloud omni (own key), kie
  nano-banana-pro priced cycle 2026-07-02.
- **Owner list/dashboard** = price taken from the owner's provider screens:
  2026-07-20 (veo flat), 2026-07-24 (seedance OR ladders, seedream-5, kie chat,
  nano-banana-2-lite, gpt-image-2 kie tiers), **2026-07-25** (kie full ladders:
  seedance-2 / -fast / -mini / 1.5-pro incl. with-video-input rates + billing
  rule, veo 3.1 29-row table, grok per-resolution, nano chain, seedream 4.5/5,
  flux kie; OR specs: happyhorse 720p/1080p, veo 3.1 per-second, seedream-4.0
  $0.04, flux $0.03/MP, full recraft ladder).
- **Contract-only** = slug + schema verified against vendor docs, no paid call
  (atlas seedream/seedance legs, flux, recraft, kling).
- **Not smoked** = code + tests exist, zero live calls. NONE as of 2026-07-25.

Smoke run 2026-07-25 (trend-derived prompts, docs/trend-radar): gemini-omni kie
leg, kie Gemini chat, kie Claude chat, happyhorse-1-1, seedream-5-lite,
nano-banana-2-lite — 6/6 PASS.

Live matrix 2026-07-26: the isolated Generate/Boards validation published 21
valid assets to its test Vitrina. It added live coverage for owned-reference
serialization on OpenRouter, Seedance 2.0 standard/fast/reference variants,
Grok, Wan, Gemini Omni, HappyHorse 1.0/1.1, and Kling.

## 8. Deliberate exclusions

- seedream-4.0 as a product — dropped from the product line 2026-07-25 (owner):
  the line is Seedream 4.5 (the `seedream-4-5` row — id renamed from the old
  4.0-era key on 2026-07-25; the model was always 4.5) + 5.0 Pro/Lite. OR price
  on record anyway: $0.04/image, 4.1K max, SG region.
- seedance-2-mini — parked (original note: "t2v 720p $0.1025/s on kie is DEARER
  than 2.0-fast; no win" — predates the 2026-07-25 kie ladders, which put mini
  720p at $0.1025 vs kie 2-fast $0.165 vs OR 2-fast $0.121; revisit only if the
  OR fast leg degrades).
- happyhorse 9-reference mode (1.1) — kie documents no such endpoint; not wired.
- veo 4K — priced on kie since the 2026-07-25 table (Quality $1.85 / Fast
  $0.90 / Lite $0.75 per video) but UNWIRED; not advertised.
- Negative-prompt controls — no active route serializes them; removed from UI
  2026-07-20 rather than advertised-and-dropped.

## 9. Remaining COGS gaps (as of 2026-07-25)

Everything above is priced on both legs unless listed here:

1. happyhorse-1-1 kie fallback — only kie-token figures (67.5/87 токенов), no $
   conversion on record; happyhorse-1-0 OR 720p rate unrecorded.
2. gpt-4o-mini-tts (studio render) — **parked/disabled; no customer route and no
   price until the Studio voice tech debt is resolved**. Prompt enhancer is
   priced above; all three Boards Prompt Studio routes are priced on Kie and their
   OpenRouter fallbacks, including supplied cached-token rates.
3. Seedance with-video input remains unavailable until input duration is
   trustworthy; its six inactive rows are explicitly listed in §3. The active
   image-only mirrors, Wan, and Kling all use their listed price-point rows.
4. baseUnits ASSUMED on price-points: omni 8s, grok 6s, happyhorse 5s; veo 8s
   is standard-but-not-finance-verified.
5. Guardrail holes: all 4 seedance rows + seedream-4-5 lack
   `capabilities.priceUsdPerUnit` — the margin guardrail does not police them
   (values now known: seedance-2-0 OR 1080p $0.340, fast $0.121, r2v worst
   $0.340 out-billed, seedream-4-5 $0.04 — a seed patch can close this).

## 10. Superseded documents (deleted 2026-07-24)

Folded into this file and removed: `pricing-source-of-truth-2026-07-16`,
`pricing-logic-endtoend-2026-07-18`, `pricing-activation-checklist-2026-07-18`,
`pricing-per-model-per-parameter-2026-07-19`, `pricing-routing-debt-ledger-2026-07-20`,
`all-model-prices-2026-07-21`, `model-serving-audit-table-2026-07-20`,
`finance-update-consolidated-2026-07-20`, `finance-request-seedance-video-input-2026-07-17`,
`finance-request-model-modes-2026-07-17`, `finance-request-omni-modes-2026-07-17`,
`live-route-test-plan-2026-07-16` (verification facts → §7), `ai-model-inventory`
(2026-07-09 baseline; JSON fixture kept for CI).

Kept companions: `docs/platform/backend-providers.md` (architecture narrative),
`docs/platform/model-gateway-contract-matrix.md` (generated, CI-guarded),
`docs/platform/provider-output-retry-billing.md`, `research/provider-wiring-audit-2026-07-24.md`
(the audit trail that led here), `research/archive/ai-model-sourcing-strategy-2026-07.md`
(vendor selection rationale).
