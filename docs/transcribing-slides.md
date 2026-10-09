# Transcribing a CSDM example slide into a .csdm file

Goal: capture the CSDM *content* of one slide (entities + relationships) as a
`.csdm` file. Layout, colours, labels and styling are derived automatically by
`src/csdm.js` — never try to reproduce positions.

## Inputs

- Slide images: `.slides/slide-NNN.png` (1920px wide, rendered by PowerPoint via `tools/extract-slides.sh` — never Keynote, which re-routes connectors; zoom with an
  image crop if text is small, e.g. python3 + PIL crop/resize into your scratch dir).
- Reference examples: `examples/slide-037-o365-platform-run.csdm`,
  `examples/slide-043-microsoft-dynamics-fly.csdm`.

## Output

`examples/slide-NNN-<kebab-title>.csdm` (NNN zero-padded slide number).

## Syntax

```
title "Slide title"
subtitle "Slide subtitle"            # optional
layout cross                         # optional; default cross (see below)
TYPE [id:] Name                      # entity
TYPE(ci class) [id:] Name1, Name2    # CI with class; comma = several instances
TYPE [id:] Name [Var1, Var2]         # variants (environments, locations): stacked, labelled cards
a -> b                               # relationship (label/style inferred)
a -> b : Label                       # only when the slide's label differs from the inferred one
# comment
```

**Layout** is the only layout choice. Every slide puts applications above (or,
in row stacks, left of) the service instances, tech offerings LEFT of what they
contain, business offerings RIGHT, infrastructure below. What varies is how far
each side runs sideways before turning down — `layout reach <delivery> <consumption>`:

```
reach 2 2  = layout row     [TMS][TMSO][SI][BSO][BS]   one row per application (37, 39, 55)
reach 2 1  = layout cross   [TMS][TMSO][SI][BSO]       BS below its BSO (default; 14-16, 41-44, 57, 67)
                                         [BS]
reach 1 2                   [TMSO][SI][BSO][BS]        TMS below its TMSO (47, 49)
                            [TMS]
reach 2 0                   [TMS][TMSO][SI]            business side stacked under the SI (31)
                                       [BSO]
reach 0 0  = layout tiers   tiers top->bottom, one column per application (19, 21, 33)
```

Measure it on the slide: where is the Tech Mgmt Service relative to its offering
(left = 2, below = 0/1), the Bus Offering relative to the instance (right = 1-2,
below = 0), the Bus Service relative to its offering (right = 2, below = 1)?

Ids are lowercase kebab (`[a-z0-9-]`). If omitted, the id is the slugged name;
give explicit ids whenever names repeat (e.g. a BA and a BSO both called "Teams").

TYPE is one of: BC (Business Capability), BA (Business Application),
SI (Service Instance / Application Service), TMS (Tech Mgmt Service),
TMSO (Tech Mgmt Service Offering), DCG (Dynamic CI Group), CI (any CI — use
`CI(Class)` e.g. `CI(Windows Server)`, `CI(Application)`, `CI(Database)`),
BSO (Business Service Offering), BS (Business Service), SP (Service Portfolio).

Inferred relationships (FROM>TO, either direction may be written; it is flipped
to the CSDM direction automatically):

| from>to | label | style |
|---|---|---|
| BC>BA | Provided by | solid |
| BA>SI | Consumes | solid |
| BA>BA | References | dashed (app -> platform host) |
| BSO>SI | Depends On | solid |
| BSO>BS | References | dashed |
| TMSO>TMS | References | dashed |
| TMSO>SI, TMSO>DCG, TMSO>CI | Contains | solid |
| DCG>CI | Query based Contains | solid |
| SI>CI, CI>CI | (none) | blue service-mapping arrow |
| SI>SI | Depends On | solid |
| TMS>SP, BS>SP | References | dashed |
| BC>TMS, BC>BS | Provided by::Provides | purple strategic |

A dash-dot line labelled "Sends data to" is a data flow: write it with that
label (`ad-prod -> sap-prod : Sends data to`) and it gets the dash-dot style,
whatever the two types are.

Any other pair still renders (unlabeled, with a warning). Add `: Label` when the
slide shows a label for it (e.g. `Runs on`, `Sends Data to`).

## Rules

- Content only. No coordinates, colours, hints. Don't edit anything under `src/` or `tools/`.
- Entities on the slide that are not CSDM types above (Product Model, Location,
  Company, Contract, Manufacturer, Department, legend boxes, explanatory notes)
  are NOT modelled; list them in a `# not modelled: ...` comment instead.
- Decorative/grouping frames and callout text: skip.
- Names: as written on the slide, minus the type prefix. Fix obvious line-wrap
  artefacts ("Infrastructur e CIs" -> "Infrastructure CIs").
- If the slide has inconsistencies (e.g. arrow direction contradicts CSDM), write
  what CSDM implies and note it in a comment.
- Validate each file: `node bin/csdmflow.js <file.csdm> -o <your scratch dir>/x.svg`
  from the repo root. It must parse; read any warnings and fix what is a
  transcription error (unknown pairs that the slide genuinely shows are fine).
- Confidentiality: these are public-style vendor examples; still, no personal names.

## Stacked boxes

- A stack whose back cards carry a label in their visible strip ("Dev", "QA",
  "EMEA") is one entity with **variants**: `SI ea: *EA Prod [Dev, QA]`. Name the
  front card; list the back cards front-to-back. Don't create separate entities
  for the back cards; a line drawn from a back card belongs to the stack.
- A stack without labels, or with several names on the front card, is **several
  instances**: `CI(Windows Server) win: Exchange01, Exchange02`.

## Connectors that run through boxes

A single connector is often attached to the last box in a row but drawn behind
the boxes in between. The image can't tell you what it means; the deck can. Run
`python3 tools/deck-passthru.py <deck.pptx> <deck-powerpoint.pdf> NNN`
(the PDF is the one `extract-slides.sh` writes) and apply this rule:

- Line runs along the crossed box's centre line (|offset| ≲ 0.1), behind it,
  and the box has **no link of that kind of its own** (own-links=0) → the box is
  part of the relationship:
  - crossed box is the same kind as the far end (e.g. several instances) →
    fan-out: the source relates to each one;
  - crossed box is a different kind on the path (instance → application →
    server) → chain: link consecutive boxes.
- Crossed box already has its own link of that kind → incidental; skip it.
- Line crosses off-centre between unrelated kinds → accidental; skip it.
- A sibling slide (same deck, near-duplicate) attaching the same connector
  differently is strong evidence — note it in a comment.

Also read connector endpoints from the deck XML when lines are hard to see: some
connectors are near-black (#032D42) and invisible on the dark background.

## Report back

Per slide: file written, entity/relationship counts, anything not modelled,
render warnings left and why. Keep it short.
