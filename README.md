# chess-coach

Watches a chess board on your screen and grades every move you play — Best,
Inaccuracy, Mistake, Blunder — with a one-line explanation of what went wrong.

Then it tells you what you *keep* getting wrong: a live dashboard that ranks
your recurring habits across every game, because one blunder is an accident and
three of the same blunder is the thing to train. See
[Reviewing a game](#reviewing-a-game).

Then it makes you play them again. `npm run play` deals back the positions you
actually lost — your side, your move — and will not move on until you have found
what was there. See [Playing it again](#playing-it-again).

## How it works

Three parts, each doing what it is actually good at:

| Part | Job |
|---|---|
| **.NET screen capture** | grabs the board region, downsamples it |
| **Template matching (JS)** | pixels to a move |
| **Stockfish** | the verdict |
| **Jev / OpenRouter** | the explanation |

**The engine grades; the model only narrates.** Move quality is the win-probability
swing across the move, which Stockfish computes exactly. Language models are
poor at chess — benchmarking five of them on a raw position produced invented
skewers, invented pins, and captures of the player's own pieces. So the model
never sees the board: it is handed the engine's refutation line, the material
outcome and the better move, and asked only to put that into a sentence. That
change alone eliminated the hallucinations.

Recognition works the same way — by knowing rather than guessing. Instead of
classifying 64 squares independently and assembling a FEN (a whole position
written as one line of text — see [Notation](#notation) — where one bad square
desyncs everything), it scores each *legal* move as a hypothesis against the
pixels and takes the best fit. Castling, en passant and promotion need no
special handling, because they are just legal moves.

### Keeping the board

Everything above rests on the tracked position being right, so the two ways it
can go wrong are handled separately.

**Not seeing the board** is a promotion picker, a game-over modal, an arrow or a
piece in mid-flight. Those squares match none of the thirteen things a square
can show — which is a measurement, not a guess, and one a *misread* square never
trips, because a misread square still looks like some piece. They are dropped
from every score rather than allowed to swamp a mean over 64, and the loop
simply waits.

**Having lost the board** is counted in squares that are outright wrong, not in
mean error. The mean cannot see a desync: on a real board, being a whole move
behind moves it from 15.1 to 17.6 against a limit of 140, so it took four plies
of drift to notice and by then recovery was hopeless. Per square the separation
is enormous — the worst correctly-read square costs 111, the cheapest wrongly
-read one 277 — so one missed move is visible immediately.

Squares the board is *expected* to decorate (the last move, a king in check) are
judged by which piece best explains them once a tint is fitted out, since a
highlight is an affine map on intensity. That makes the test blind to the
highlight's colour and strength while still refuting a wrong piece — and it is
why accepting a move can demand that it explain the board completely. That
strictness is deliberate: a missed move leaves the truth a couple of plies
ahead where it can be found again, while a *wrong* move moves onto a line the
game never played, from which no search forward ever recovers.

The king and queen are the two pieces this has to work hardest for, because
they stand on a single square colour in the opening and their opacity is
estimated rather than solved. That estimate used a fixed ramp of a quarter of
the board's contrast, about 23 grey levels, while a genuinely covered pixel
deviates by nearly 200 — so every half-covered pixel saturated at opaque and
the learned background got baked into the piece. It cancels out at home and
costs a fifth of the contrast per pixel the moment the piece steps onto the
other shade: a black king, learned on light e8, cost 2116 on dark f8 against a
limit of 200, where the black *queen* explained him at 311. The ramp is now the
deviation a covered pixel actually shows, measured off the piece.

**Any** square that fails the pixel threshold is then asked that same weaker
question before it is counted, because the board decorates squares the position
cannot predict: the piece you have selected, the one under the cursor, an
arrow, a premove. Measured on a real session, a selected queen cost 1441
against a limit of 206 while remaining the best explanation of her own square —
the right piece, too expensive. Held to the threshold, one such square is wrong
under *every* hypothesis at once, so no move can be accepted and no resync line
comes back clean; that session lost five minutes to it. The second chance is
not an excusal, which is the distinction that matters: it asks the tinted
reading to name the *expected* piece, so a hypothesis claiming a pawn on an
empty square is refuted exactly as before.

And one square may still defeat both tests — three separate faults each did,
and each killed a session from a perfectly tracked position, because a move
that must explain the whole board can never explain one square that nothing
explains. So a square that is wrong *whichever* way we read it, and that the
move leaves alone, is left out: it cannot tell the two readings apart, which is
the same fact the occlusion mask already acts on, reached from the other side.
Exactly one square of that, though. Two is a board that has run two plies
ahead, and being behind is what the recovery ladder is for — at a looser bound
a board four plies behind was measured accepting a move from a line the game
never played, which is the one mistake nothing recovers from.

A board can also move the *other* way — a takeback, a premove reverting, a move
confirmation dismissed — and that is invisible to every search, however deep,
because the truth is behind us rather than ahead. Measured on a real session: a
knight went to c6, sat there for ten settled frames, was accepted and graded,
and then went back to b8; the coach was lost for the next fifteen minutes on an
ordinary game. Going back is also the cheapest thing recovery can do, since the
position is one we were already in and only has to be scored, so it is tried
first.

There is a third direction, and it is the one that took longest to find. A move
can be *recorded that was never played*: you pick a piece up, hold it over a
square while you decide, and for as long as your hand is still the screen is
pixel-identical to a board where that move has been made — the stillness test
cannot tell a settled board from a settled cursor. Then you put the piece
somewhere else. The truth is now one ply *sideways*: the position we were in
before, with a different move out of it. A takeback test says no, because the
board did not go back — the piece is on the board, just not where we said. A
forward search says no, because the truth does not follow the phantom. Measured
on the session that found it, a three-ply search did eventually match all 64
squares, by way of `Bb5 Be6 Bc4` — a line the game never played — and refused it,
rightly, for leading the field by nothing. Asked properly the question is nearly
free: undo one ply and score a single ply of moves, about thirty positions where
the two-ply search does nine hundred.

Two things guard it, because prevention is partial and recovery is not. A piece
held under the cursor is *displaced*, and displacement is what an affine fit
cannot absorb — so the tinted reading that excuses a highlighted square is now
bounded by the residual it leaves, which on a real game separated every landed
square (worst 0.59x the square limit, highlight included) from a held bishop
(3.66x) with room to spare. That narrows the window rather than closing it: a
dragged piece crossing a square is sometimes centred enough to pass, and on the
session above the bound moved the phantom from g4 to f5 instead of preventing it.
What actually saves the game is the rung, which recovered either way — and then
tracked the next six moves that the unpatched run spent lost.

And the board may not be this game's board at all. Start a second game without
restarting the coach and the screen goes back to move 1 while the tracked
position is deep in the last one — which is not ahead of us or behind us, so no
search of any depth reaches it. That is the one case where the *right* answer is
to stop tracking this game: the opening position is not read off the screen and
guessed at, it is known exactly, castling rights and all.

So losing the board is no longer a reason to restart. Seven rungs, cheapest
first, each one validated before it is kept and reverted if it cannot prove
itself:

| After | Rung |
|---|---|
| every frame | is the screen a *new game*? — two scores, so it is asked at once |
| ~1.2s | go *back* a move or two — the board was taken back |
| ~1.2s | go *sideways* — the last move we recorded was never played |
| ~1.2s | search two plies ahead — you moved and we missed it |
| ~5s | search three plies |
| ~9s | read all 64 squares, if every one is unambiguous |
| ~13s | re-measure the region, in case the board moved or was resized |

The first one does not wait its turn because what it looks for does not wait
either: the opening position is on screen only until the new game's first move.
Replayed against the session that found it, that window was four frames wide,
shut, and reopened two minutes later — a rung at the usual depth would have
landed between the two and fixed nothing.

Only if all of them fail does it say so — and then the message means something.

### Why Node and not Python

Smart App Control is enforcing on this machine and blocks unsigned native code,
which rules out numpy, OpenCV and Pillow (verified: CodeIntegrity event 3118).
Everything here is either pure JavaScript or a signed Microsoft assembly.
Stockfish is native but was never blocked.

## Setup

### 1. Stockfish

Place the Stockfish binary at `engines/stockfish/stockfish-windows-x86-64-universal.exe`:

- Download Stockfish for Windows (x86-64-universal) from [stockfishchess.org/download](https://stockfishchess.org/download/) or GitHub releases.
- Extract or place the binary into `engines/stockfish/stockfish-windows-x86-64-universal.exe`.

### 2. Install & Calibrate

```
npm install
npm run calibrate         you drag a rectangle around the board
npm run calibrate:auto    or it finds the board on your screens itself
```

Either way, put the board in the **starting position** first — that is what
makes the templates ground truth rather than a guess.

Start a **fresh game**, not a rematch that still shows the last move's
highlight. Calibration cannot tell a decoration from the board: a tint sitting
on a square is learned as that square's own appearance, fits perfectly for as
long as it is there, and then misfits by thousands the moment it clears — under
every hypothesis at once, so no move can be accepted at all. A real session lost
seventeen minutes to one such square while the board sat in the opening
position. Calibration now says so when it sees it, and

```
node tools/check-calibration.mjs
```

says it about the calibration you already have, without re-running anything.

Drag it slightly **too big** — a few pixels outside the board on every side.
The grid is then measured from the nine lines a checkerboard must have, and the
slop is trimmed off rather than shifting every square. Trimming is the only
direction that works: the measurement can shrink your rectangle onto the grid
but never grow it, so a drag that lands *inside* the board is not recoverable
and every square ends up sampled off-centre. It learns this board's piece
sprites from a position it already knows.

Which way round the board is gets **two** independent readings, and it stops if
they disagree:

```
orientation:
  ink       white 171.4 vs black 69.0  (apart by 102.4, needs 24.2)  -> black at bottom
  brightness far 186.6 vs near 152.7  -> black at bottom
  black at bottom (flipped) — you are Black
```

`ink` is how the two sides are drawn, with the square behind them divided out —
a piece set draws White lighter than Black. `brightness` is which end of the
board is lighter overall. They fail in different places, so agreement is worth
something. Getting this wrong is not cosmetic: the colour names are baked into
the templates, every later check is then made of the same mistake and agrees
with it, and the whole game is graded for your opponent. So when the two
disagree, or the sides are drawn too alike to call, calibration refuses to write
anything and asks you to settle it:

```
npm run calibrate -- --flipped true      you are Black, black at bottom
npm run calibrate -- --flipped false     you are White, white at bottom
```

This is only about which way the *board* is drawn. Which colour you are playing
is re-read from the board at startup and at every new game, so calibrating as
White and then being handed Black corrects itself and says so.

Each run leaves `captures/calibration.png` — exactly what was captured, which
is the fastest way to see whether the region was right.

Re-run it if you change board theme or piece set. You do **not** need to re-run
it just to play the other colour.

### Finding the board itself

`calibrate:auto` scans every monitor and hands the rectangle it finds to the
same calibration. Only the source of the rectangle changes: it was always just
a hint, since the grid inside it is measured either way, and the checks that
follow — square contrast, and whether the start position explains the frame
better than any legal successor — decide whether it is a chess board at all. So
detection is allowed to propose a wrong rectangle, because calibration can
already prove one wrong. That is the same structure as recovery: validate, and
revert if it cannot prove itself.

What it keys on is the one thing a chess board has that the rest of a desktop
does not. Not evenly spaced lines — a spreadsheet, a calendar and a window
border all have those, which is why the line fit in `grid.js` is only
trustworthy once you already know you are looking at a board. It is that the
cells **alternate**, tested the strict way: every cell of one shade must be
brighter than every cell of the other, so a near-miss fails outright. The
starting position hands it those cells for free, because the middle four ranks
are empty. The outer two files are skipped, since some themes print rank
numbers inside the board's edge.

Alternation says *this is a checkerboard*; it cannot say where one **ends**. A
checkerboard is periodic, so a fit slid sideways by a whole cell alternates
just as well — it merely swaps the two shades. That slide is the one error the
search must not make, because it lands the rectangle a cell inside the board on
one side and trimming can never undo it. So the extent is measured separately,
as the **weakest** of the nine lines the fit claims: every line of a correct
placement is a real board line, while a slid one puts its last line out in
blank desktop where there is nothing to find. A sum would hide that behind
seven strong ones.

It reports every candidate rather than only the winner, because two boards on
screen at once is the one case where a search can be confidently wrong — and
then the drag settles it.

```
node tools/find-board.mjs
```

looks without calibrating, and leaves `captures/found-board.png` of what it
would have used.

## Use

```
npm start                  grade your moves
node src/main.js --all     grade both sides
node src/main.js --fen "…" start from a position other than the opening (a FEN —
                           see Notation below for how to write one)
npm run review             what you keep getting wrong, across every game
npm run dashboard          that, as a page, without playing
npm run play               play the positions you lost, until you stop losing them
```

A live review dashboard opens by itself when the coach starts, and follows the
game as you play — see [Reviewing a game](#reviewing-a-game).

A small always-on-top window shows the verdict; drag it anywhere. Ctrl+C stops.

### Asking the coach

Three questions, one key each, while it is your turn. Press a key again to go
deeper on the same question.

| key | question | |
|---|---|---|
| `t` | what is he threatening? | one shallow search, only when you ask |
| `w` | what is weak in my position? | free, no engine at all |
| `c` | does this move matter? | free, the grader run on the runner-up line |

```
> t
   .. he has a mating idea here
> t
   .. it is aimed at your pawn on f7
> t
   .. Qxf7# is the idea — it is mate next move

> w
   .. your pawn on f7 is attacked 2 times and defended 1
```

Press on the **overlay window** or type in the terminal — both work. The overlay
is always-on-top and shown with `ShowDialog`, so it takes the keyboard as soon
as it appears and the terminal stops seeing keys; reading the key in both places
is cheaper than wrestling focus back, which would need P/Invoke and native code
this project avoids.

**Nothing names your move, and nothing will.** A hint that says "play Nf6"
deletes the thing it is attached to: you would play it, every move would grade
Best, and the grader would have nothing left to teach. Pointed at a rated game
rather than a coach bot, it would also simply be engine assistance.

That constraint used to be the *organising* idea, and the result was useless —
a single ladder built around "what can I say that is not the move" produced
"look at the kingside", which is a gesture rather than advice. A coach organises
around what you failed to see instead, and asks about the opponent's idea long
before your own. Naming his threat, or naming your own loose piece, points at
the problem and leaves the move to you.

The threat is found by handing him a free move and searching: whatever the
engine plays is by definition what he most wants to do next. The other two
topics cost nothing — `c` reuses the search the grader was going to run anyway.

A move you asked about is logged as `[you*]`, so a session stays a truthful
record of what you found unaided.

## Reviewing a game

A grade tells you that a move was bad. It does not tell you what you *keep*
doing, and that is the thing worth training: one blunder is an accident, three
blunders that are all "left a piece nobody was defending" is a habit.

So when a game ends — Ctrl+C, or a new game starting under the coach — it is
reviewed, and the reviews are collected into one page:

```
how that went:
  26 of your moves graded, accuracy 73.4%  (6 Best, 5 Excellent, 8 Good, 3 Mistake, 4 Blunder)
  most costly habit: losing exchanges — 2 moves, 119% of win probability
    e.g. your pawn on f5 is not defended well enough — Bxf5 costs you a pawn
  the full review, and every other game: …\reports\index.html
```

`reports/index.html` is one self-contained file — no build step, no network —
ranking your habits across every game you have played, with the games
underneath as the evidence. The data is inlined rather than loaded from `logs/`
because a `file://` page cannot read its siblings, so the file works on its own,
opened from anywhere, with nothing running.

### What is on the page

**Find the move.** Reading "your knight on d4 had nothing defending it" teaches
much less than being shown that position with the answer hidden and having to
find it. So the page opens with your own mistakes as cards: the board as you saw
it, whose move it is, and nothing else — no grade, no cost, no name for the
fault, because each of those answers the question before you have looked. Reveal
shows the move you played and the move that was there, marked on the board in
the two colours the grades already use, with the line that punished you and the
line that was better. `‹ ›` or the arrow keys move through the deck; space
reveals.

The deck is taken across faults rather than straight down the worst list —
sorted purely by cost, the first ten cards are the same mistake ten times.

**Click the board and it plays.** A bad move is rarely bad on its own — it is
bad for the answer it allows, and "he answers Rxd4 Ke7" is a line you were left
to play out in your head against a position sitting right in front of you. So
the board opens: your move and how you were punished, then the move that was
there and how it went on, one ply at a time, on the same position. `‹ ›` or the
arrow keys step through it, any move in the line jumps to it, space replays, Esc
closes. The diagram beside each habit opens the same way — and the trainer's
only after you have revealed the card, since a replay of the answer is the
answer.

The lines come out of the searches the coach already ran, so they cost nothing
to keep. A review written before they were kept opens on the two moves alone and
says so; `node tools/review.mjs --all` re-reads the logs and brings the rest
back, without Stockfish and without re-grading anything.

**Every habit reads as a lesson**, not a heading: what the fault is, why a human
makes it, the checklist to run at the board while you still have the move, and
one thing to drill. Hand-written, fixed, and not generated — it is the part of
the page you are meant to remember, so it has to read the same way twice.

**Am I fixing it?** Each habit carries its own history, as cost per 10 of your
moves, game by game. Games where a fault did *not* happen count as zeros —
counting only the games it appears in makes the one outcome you are working for
invisible, since a habit you have fixed simply stops appearing. A verdict needs
four games in view and at least two occurrences, and a ±15% move reads as flat;
below that bar the page says "no trend yet" and why, rather than reading a
direction out of noise.

**Where each game turned** — your chance of winning after each of your own
moves, with the two or three that actually changed it marked by name. **Where it
goes wrong** splits by phase and by colour, in accuracy as well as in win
probability lost, since accuracy is bounded and can therefore be compared
between them. **Lost to blunders** says whether you are losing games to a
handful of catastrophes or leaking evenly — two problems that need opposite
advice.

A review written before the page kept positions has no cards. The page names the
fix where the deck would be:

```
node tools/review.mjs --deep --all
```

### The dashboard

That file still has to be opened, and it only changes when a game ends — which
is the wrong moment. The review is worth seeing two moves *after* you dropped a
piece, and nobody is going to go and run a command then.

So the coach serves it while it runs, and pushes a refresh after every graded
move:

```
board:  live review at http://127.0.0.1:7171/ — it updates as you play
```

It opens once, by itself, the first time. The game you are playing appears at
the top of the table marked **on the board now**, filling in as you go, and your
scroll position and whichever habit you had open survive each refresh.

```
npm run dashboard                    without playing, to look back over old games
npm run dashboard -- --port 8080     if something already has 7171
npm run dashboard -- --no-open       don't take a browser tab
```

Run on its own it watches `logs/`, so a coach playing in another terminal — or a
`--deep` review finishing — updates the tab you already have open.

It is the same generated file, served with six lines of script appended: one
page, one data path, and no way for the served view and the file to disagree.
It binds to **127.0.0.1**, so it is reachable from this machine and nowhere
else. A port already in use is the ordinary case of a second coach, and it
quietly does without rather than failing to start a game.

| | |
|---|---|
| `COACH_DASHBOARD=0` | don't serve it at all |
| `COACH_OPEN=1` | also open a browser at it when the coach starts |
| `COACH_PORT` | default `7171` |

```
npm run review                          the newest session
node tools/review.mjs --all --open      every session, then open the page
node tools/review.mjs --deep logs/<id>  re-grade that one with Stockfish
node tools/review.mjs --pgn game.pgn    any PGN, from anywhere
```

### The two sources

Both produce the same thing; only the evidence differs.

| | |
|---|---|
| **instant** (default) | the grades the coach already computed while you played. Free, and exactly what you were told at the time — but your side only, and only the moves it actually saw. |
| **`--deep`** | Stockfish walks the finished PGN: every move, both sides, one uniform depth, including the moves a desync swallowed. About a second a ply. |

Deep is not twice the work it looks. The position after your move is the one
your opponent moves from, so each `after` search is the next move's `before`
search, handed straight back through the parameter `gradeMove` already has for
it — one search a ply rather than two.

A deep review is never silently replaced by a live one: an `--all` pass over a
session that already has one keeps it and says so. `--force` if you mean it.

### What it can name

Every fault is a measurement against a position we stored and a line the engine
returned — is the captured piece defended, was it already standing there, does
this knight hit two things at once. Nothing here asks a model what it thinks
went wrong, for the same reason `audit.js` does not: the honest answer is
already computable.

| | |
|---|---|
| **Walking into mate** | checked first, and before any material test — a mating attack is usually *paid for* in material, and counting the sacrifice would file a forced mate as "you won a piece" |
| **Hanging pieces** | his move takes something of yours that nothing was defending |
| **Ignoring his threat** | ...and it was already standing there, already attackable, before you moved. The same capture, a different mistake: one you walked into, one you were shown and did not answer |
| **Forks** | the move that punishes you hits two pieces at once, or checks while hitting a second |
| **Losing exchanges** | the trade comes out badly — worded differently depending on whether *you* started it |
| **Missing what was there** | nothing was lost; the cost is what you passed up |
| **King safety** | the king was already a problem and this move did not address it |
| **Positional drift** | no material changes hands at all |

Ranked by the win probability each one actually cost, which is the grader's own
currency — so the review can never disagree with the grade you were shown while
playing.

**Accuracy** is Lichess's published curve, deliberately borrowed rather than
invented: the number is only useful if it means what it means on the site you
played the game on.

### What it will not name

There is no fault for a *quiet* threat you ignored. Proving one means asking
what the position is worth before and after a free move — a search, which is
what `t` pays for during the game and what a review of a finished game has no
business paying for per move. Tested on real positions, the cheap version of
that test ("he could already have played it") fires on almost every quiet move
there is, and would file half a game under threats you ignored. So a quiet
punishing move is left to the branches that can name what actually happened.

**Positional drift is the honest residue**, not a diagnosis. It means no
material moved and nothing above matched — usually a real positional concession,
sometimes a tactic too long to see in the first exchange. It is the bucket to
look at with an engine rather than the one to train against.

Old sessions still review: their logs predate the grade record carrying enough
to classify from, so the page shows their accuracy and grades and says outright
that the detail needs `--deep` — which their `game.pgn` makes available
retroactively.

## Playing it again

A review tells you what you keep getting wrong. It cannot make you *do* it
differently, and that is the part that transfers: a pattern you have read about
is recalled, a pattern you have played is recognised.

```
npm run play                  a session from your worst habits
npm run play -- --dry-run     the deck and the picks, without starting anything
```

It hands back positions out of your own games — the same position, the same side,
your move — and does not move on until you have found what was there. Then you
play it out against the engine, because the move is only half of it: the reason
`Qxe4+` was right is the three moves after it.

```
116 positions worth replaying, from 53 reviewed games.
    43  Ignoring his threat
    29  Missing what was there
    12  Forks and double attacks
    ...
this session — 8 positions:
   1. Missing what was there      95% lost   Black, move 24  new
   2. Ignoring his threat         94% lost   Black, move 18  new
```

Click a piece and then its square. `t` / `w` / `c` ask the same three questions
as the live coach, and are answered by the same code. `b` takes your last move
back — see [Taking it back](#taking-it-back).

### What a position has to be

Taken from `logs/*/review.json`, so it needs games that have been reviewed and
nothing else — no re-grading, and no Stockfish at all until a session starts.
A position qualifies when it cost at least 8% of your winning chances, is past
move 4, and the fault behind it is one with a move that is recognisably right.

**Positional drift is not drillable**, on this project's own grounds: it is the
residue, and "no material changes hands" has no move to find. Marking you wrong
for picking a different quiet developing move would teach nothing. The same goes
for a move that ended the game — mate is not a mistake, whatever the grade says.

Which positions you get is weighted by what each habit has actually cost you,
not by how often it happens, so most of a session is the two faults that are
over half your total loss. Within a habit: what you failed last time first, then
what you have not seen, then the most expensive. What you passed in the last two
days is held back — but never excluded, so a deck you have been through still
deals a session.

`--kind missed-threat` spends the whole session on one habit. `--size 12` for a
longer one.

### What the coach does at every move

| | |
|---|---|
| before you move | how much the position cost you, and on a *first* encounter the class of mistake — "something of yours is already attacked here" |
| you find it | the grade, and the pattern to take away |
| you miss it | the grade, the fault named from the board, and **his answer played out on the board** rather than written as a line you have to imagine |
| after that | his reply, and a verdict on every move of the continuation |
| you miss again | more than last time — see [the ladder](#where-this-bends-the-rule) |

Judged by the grader itself: a move passes when `classify` would have called it
Good or better. There is deliberately no second standard, so a drill can never
disagree with the grade the live coach would have shown you for the same move.

### Taking it back

The rep is one move, but the three moves after it are half the lesson — and a
continuation played into a lost position teaches nothing, least of all the two
moves still left in it. So `b` takes your last move back, along with his answer to
it, and hands you the same position to try something else on.

It is available any time it is your move: after a blunder, and after a move that
was merely timid. The one move it will not take back is the rep itself, because
un-solving the drill is not retrying the line — a missed rep has `r`, and that is
scored as a miss.

A take-back is help, so it costs you the "found first time" count exactly as
asking `t`/`w`/`c` does. And unwinding the same ply over and over climbs the same
ladder as missing the rep does:

### Where this bends the rule

The coach will not name your move while you are playing. A drill is the one place
that gives way, because a position you cannot solve would otherwise be a dead end
and the answer is already on the review page. So, per position you keep getting
wrong:

| miss | what you get |
|---|---|
| 1 | his punishment on the board, the fault named, and what to look at |
| 2 | and the loose piece named outright — the `w` topic's first line |
| 3 | a real tip: whatever `w` has to say next about your position |
| 4 | what he is threatening, as `t` would have told you |
| 5 | how much the choice matters, as `c` would have told you |
| 6 | the move |

The tips are not written for this. They are the `t`/`w`/`c` answers, produced by
the same code the buttons use, so the coach says the same thing whether you asked
or it volunteered — and every one of them is recorded against your "found first
time" count, because help is help however it arrived.

**Only the rep ever reaches the last rung.** Past it there is no stored best move
and nothing to reveal, so a continuation you keep unwinding runs to the tips and
stops there. Never before you have moved, and never in the question itself.

`logs/play-history.json` remembers what you have seen, so the next session brings
back what you failed. Ctrl+C banks whatever you finished — an abandoned session
still taught you the positions you got through.

| | |
|---|---|
| `COACH_PLAY_PORT` | default `7272`, so it never fights the dashboard's `7171` |
| `COACH_PLAY_OPP_DEPTH` | default `12`. How hard the opponent plays — grading stays at `COACH_DEPTH`, because that is what your grades have always meant |

## Diagnosing a desync

Every run records itself into `logs/<timestamp>/`, and the point of keeping it
is that a desync is not reproducible on demand — by the time you notice the
grades have gone strange, the frame that caused it went past some minutes ago.

```
logs/<run>/session.jsonl   every frame's numbers, every move, every recovery
                           attempt including the refused ones and why
logs/<run>/frames.bin.gz   every frame's pixels, so the decision can be taken
                           again offline
logs/<run>/game.pgn        the game as the coach believed it went
logs/<run>/review.json     the games of that session, reviewed — see Reviewing
                           a game. Outlives frames.bin.gz, which is the big file
                           and the first one anybody deletes
```

A frame is 16KB at ~6.7/s, which raw would be 400MB an hour; gzipped over a
board that is mostly sitting still it is a small fraction of that, because
consecutive frames of an untouched board are identical. That 16KB is
`SAMPLE * SAMPLE` bytes a square, so raising the sample rate grows the logs as
its square — and invalidates the ones already recorded, since they are replayed
through templates learned at the old size. `COACH_LOG=0` turns the whole thing
off.

After a session that went wrong:

```
node tools/log-summary.mjs            the newest run, on one screen
node tools/replay.mjs --board 912     what the screen actually showed at frame 912
node tools/frame-png.mjs              that frame as an actual picture
```

The summary prints the timeline — moves, every episode of lost sync with the
frames it spans, every rung of the ladder and the reason it refused — and then
names the cause where the log is unambiguous about it. Where it is not, it
points at the frame to look at.

`replay.mjs` re-runs recognition over the recorded pixels: same model, same
position, same frame, and this time the whole ranking is printed rather than a
boolean. It reads `COACH_MOVE_THRESHOLD` and `COACH_MOVE_CONFIDENCE` from the
environment like everything else, which makes it the place to find out whether a
different threshold would have caught the move — without playing another game.
`--board` draws the position we believed beside what each square actually looks
like, which settles most arguments in one glance:

```
     believed            on screen
    r . b q k b n r      r n b q k b n r    8
    p p p p . p p p      p p p p p p p p    7
    . . n . . . . .      . . . . . . . .    6
    . B . . p . . .      . . . . . . . .    5
```

That one is not a misread move. That is a **new game** — which the log says
outright, because while it is lost the coach measures the opening position
against the screen, both ways round, on every frame. It also acts on it: a
board that matches the opening position exactly, with nothing covering it, is
the next game, and the coach starts over rather than staying lost.

`frame-png.mjs` writes a recorded frame back out as a PNG — the 64 grayscale
tiles laid out as they sat on screen, with the capture's own square boundaries
drawn on. It answers the question the tables above cannot: *what was actually
there?* A theme change, a board the other way round and a region that has
slipped all read as "dozens of squares wrong" in the numbers and are each
obvious in the picture at a glance.

```
node tools/frame-png.mjs                      newest session, first settled frame
node tools/frame-png.mjs logs/<id> 912        a particular frame
node tools/frame-png.mjs logs/<id> 1 out.png 6    somewhere else, 6x
```

Without an argument it writes `frame-<seq>.png` into the session's own log
directory.

### What a desync looks like in the log

| in the log | what happened |
|---|---|
| `start-position probe: 0 squares off` | a new game began under the coach |
| `new game OK` | ...and it was recognised; the old game is in `game.pgn` |
| `new game refused (occluded/margin)` | it looked like one and could not be proved |
| `re-read refused (material)` with `isStart` | a new game that got past the rung for it |
| the true move present but second, `lead` small | a frame caught mid-animation |
| `resync 2ply OK` | a move was missed and recovered; normal |
| `flip OK` | you are playing the other colour now |
| many squares wrong, no probe hit | a misread move, or the theme changed |
| `! board levels are +11 light / +14 dark` in the header | the theme changed — re-calibrate; nothing will grade until you do |
| `orientation` block naming a correction | you were handed the other colour; the board was read, not assumed |
| `calibrated by ... — DISAGREED` | the templates were written over an orientation the evidence did not settle |
| the *same* square wrong on every frame, from the first | it was decorated at calibration — run `check-calibration` |
| `e4:bq tinted(1441)` — the expected piece, too expensive | the board is painting that square for a reason we cannot predict |
| a rung repeating every ~14s | it outran the poll; see `Ladder` in `src/watch.js` |
| two squares, one emptied and one filled, right after a move was accepted | the board went *back* (taken back) or *sideways* (that move was never played) |
| `g4:bb tint 2776 > 1518` on a refuted square | a piece was being *held* over it, not placed on it |

## Notation

Everything printed here is standard chess shorthand, so it is worth reading once.

### A line of the move log

```
[you ] Nxe5    Blunder     +0.3 -> -2.6  (-31.4%)
 │      │       │           │      │       └ win probability you gave away
 │      │       │           │      └ ...and after it
 │      │       │           └ engine evaluation before your move
 │      │       └ the grade
 │      └ the move, in SAN
 └ who played it: you / opp, `*` you asked a question first, `~` found by recovery
```

**Evaluation** is in pawns, from your point of view: `+0.3` means you stand about
a third of a pawn better, `-2.6` that you are losing by more than a piece, `0.0`
dead level. `M3` instead of a number means forced mate in 3 — positive is you
giving it, negative is you receiving it. Internally the engine counts
**centipawns** (cp), hundredths of a pawn, which is why `+0.3` is `30cp`.

The grade itself is not the evaluation swing but the **win probability** swing:
losing 2 pawns while already a queen up costs almost nothing, and the same 2
pawns in a level position loses the game.

### SAN — Standard Algebraic Notation

What the move log shows, and what you read in any chess book.

| | |
|---|---|
| `e4` | a pawn to e4 (pawn moves name no piece) |
| `Nf3` | knight to f3 — **K**ing, **Q**ueen, **R**ook, **B**ishop, k**N**ight |
| `Nxe5` | knight **captures** on e5 |
| `Nbd2` | the knight on the b-file, when either knight could have gone |
| `O-O` / `O-O-O` | castles kingside / queenside |
| `e8=Q` | pawn reaches e8 and promotes to a queen |
| `Qh5+` | check |
| `Qxf7#` | checkmate |

Squares are file (a–h, left to right from White's side) then rank (1–8, White's
end to Black's).

**On the report page you do not have to remember any of this**: every move is
underlined, and hovering one reads it out — `Nxf8` as "knight takes on f8",
`exd8=Q+` as "the pawn on the e-file takes on d8, promoting to a queen, with
check". It covers the moves inside the engine's lines too, which is where the
notation is least familiar and most worth reading.

It is read from the notation itself rather than looked up in the position, so it
says *knight takes on f8* and not *which* knight or what it took. That is
deliberate: the moves in a variation have no position stored, and a reading that
worked only on the move you played would explain the notation in exactly the
cases where it is already obvious. It is also the structure that is being
learned — capital letter is the piece, `x` is a capture, the square comes last.

For the same reason it is attached only to moves, never to the sentences beside
them: "your pawn on **f5** is not defended well enough" contains a square, and
reading it back as "pawn to f5" would teach the notation wrongly.

### FEN — Forsyth–Edwards Notation

One whole position on one line: what `--fen` takes, and what the coach prints if
it ever has to re-read the board from scratch. The opening position is

```
rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
└─────────────────── 1 ───────────────────┘ 2 3    4 5 6
```

| | field | how to read it |
|---|---|---|
| 1 | pieces | the eight ranks, **8 down to 1**, each left to right. **UPPERCASE is White**, lowercase is Black, and a digit is that many empty squares in a row — so `4P3` is four empty squares, a white pawn, three empty. |
| 2 | side to move | `w` or `b` |
| 3 | castling still available | `K`/`Q` White kingside/queenside, `k`/`q` Black's, `-` none left |
| 4 | en passant target | the square a pawn just skipped over, e.g. `e3`, or `-` |
| 5 | halfmove clock | moves since the last capture or pawn move, for the 50-move rule |
| 6 | move number | |

So `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1` is the position
after 1.e4: same pieces, one white pawn moved from e2 to e4, Black to move, and
e3 is flagged as capturable in passing.

### The rest

| | | |
|---|---|---|
| **ply** | one half-move | one move by one side. "Two plies ahead" is you moved and he replied. |
| **accuracy** | | a whole game in one number, 0-100. Each move is scored off the win probability it cost and the scores averaged — Lichess's published curve, so it means what it means there. A move that costs nothing is 100; costing 10% is already down at 66. |
| **PV** | principal variation | the line the engine thinks both sides should play |
| **MultiPV** | | asking for the best *n* lines instead of just one |
| **UCI** | Universal Chess Interface | the text protocol Stockfish speaks. Its moves are just from-square + to-square — `g1f3` for `Nf3`, `e7e8q` for `e8=Q`. |

## Configuration

Environment variables, or a `.env` file in this directory:

| Variable | Default | Meaning |
|---|---|---|
| `JEV_API_KEY` | — | OpenRouter key. Without it you still get verdicts, just no explanations. |
| `COACH_MODEL` | `qwen/qwen3-30b-a3b-instruct-2507` | Chosen by benchmark: correct, names the better move, ~1.5s, $0.00003/move. |
| `COACH_DEPTH` | `18` | Stockfish depth. ~1s per move; drop to 15 if it lags. |
| `COACH_MOVE_THRESHOLD` | `6` | How much better a move must fit the pixels than "nothing changed". Raise if it sees phantom moves, lower if it misses real ones. |
| `COACH_MOVE_CONFIDENCE` | same as threshold | How far the winning move must lead the *runner-up*. Guards against frames caught mid-repaint, where every candidate is wrong at once and the field bunches. `tools/probe.mjs` prints it as `lead`. |
| `COACH_SOFT_SLACK` | `2` | Multiple of the square limit a decorated square's *tint-fitted* error may reach before it counts as wrong rather than merely highlighted. This is what stops a piece held under the cursor being read as a piece that landed. Raise it if real moves are consistently accepted a frame or two late; lower it if phantom moves get through. On a real game the worst landed square measured 0.59x and a held bishop 3.66x. |
| `COACH_THREAT_DEPTH` | `12` | Depth for the `t` search. Finding *what* he threatens needs less depth than pricing your move does. |
| `COACH_LOG` | on | Set to `0` to stop recording sessions to `logs/`. See [Diagnosing a desync](#diagnosing-a-desync). |
| `COACH_DASHBOARD` | on | Set to `0` and the coach serves no dashboard. Reviews are still written to `reports/index.html`, which needs nothing running. |
| `COACH_OPEN` | off | Set to `1` and the coach opens a browser at the dashboard on startup. Off by default: the window lands over the board it is trying to watch, and takes the focus with it. Safe on a second monitor. `npm run dashboard` opens a tab regardless — there is no board to cover. |
| `COACH_PORT` | `7171` | Port for the dashboard, on `127.0.0.1` only. |

Only Inaccuracy, Mistake, Blunder and Brilliant are narrated. Asking a model to
explain a good move invites it to invent a fault, so the rest are left alone —
which also keeps a full game well under a cent.

## Tests

```
npm test                  320 tests, including live Stockfish
node tools/demo.mjs       grade known positions end to end, no board needed
node tools/review.mjs     what you keep getting wrong; --deep to re-grade
node tools/dashboard.mjs  the review dashboard, without playing
node tools/play.mjs --dry-run  the drill deck and this session's picks
node tools/probe.mjs      watch recognition only: no engine, no coach, no overlay
node tools/find-board.mjs look for the board, change nothing
node tools/log-summary.mjs  what happened in the last session
node tools/replay.mjs       re-run recognition over its recorded frames
node tools/check-calibration.mjs  is the saved calibration worth playing on
```

Recognition is tested against a synthetic board renderer, so castling,
promotion, flipped boards and heavy pixel noise are all covered without needing
a screen. Board search is tested the same way, against a synthetic desktop:
what matters there is not finding a checkerboard but refusing the furniture
that looks like one — a table of equal pitch, a striped list view — and never
landing a cell inside the board it did find.

## Layout

```
src/capture.js    talks to the capture daemon
src/grid.js       finds the 8x8 grid inside a roughly-dragged region
src/board.js      pixels -> move (template matching, legality filtering)
src/engine.js     Stockfish over UCI
src/watch.js      when a detected move is real (settled, fits, beats standing still)
src/grade.js      engine evaluations -> a graded move
src/verdict.js    win probability and labels
src/review.js     graded moves -> the habit behind them, no engine needed
src/report.js     the review page, and where reviews are kept
src/dashboard.js  serves that page on localhost, refreshed as you play
src/play.js       which of your lost positions to replay, and when you may move on
src/play-server.js the play session: the coach pointed at a position, not a screen
src/play-page.js  the board you play on; it knows no chess
src/coach.js      the one place a language model is used
src/hint.js       the coaching topics behind t / w / c
src/audit.js      what is weak in your position, no engine needed
src/threat.js     what he is threatening, via a null move
src/log.js        the session record: every frame, kept
src/overlay.js    drives the overlay window
src/calibrate.js  one-time board setup
src/find-board.js finds the board on screen, so the drag is optional
src/main.js       the loop
ps/capture.ps1    screen capture daemon (signed .NET)
ps/scan.ps1       one-shot grab of any rectangle, for the search
ps/screens.ps1    monitor geometry
ps/pick-region.ps1 drag-to-select overlay
ps/overlay.ps1    always-on-top verdict window
```

## Known limits

- **Templates are theme-specific.** Change board or pieces, re-calibrate.
- **Move detection is tuned on synthetic frames.** `COACH_MOVE_THRESHOLD` may
  need adjusting against your real board; `tools/probe.mjs` prints the numbers
  it is judging, live.
- **Calibration must not be skipped after a theme change.** New pieces or new
  square colours mean new templates. A board that has merely *moved or been
  resized* no longer needs it: every square is resampled to 16x16, so the
  templates are scale-invariant and recovery re-measures the region itself.
  Neither does a board that has *turned round* — playing the other colour, or
  pressing the site's flip button. Orientation is picked up at calibration but
  re-checked whenever the board stops making sense, and a 180 degree rotation
  is the one change the templates survive whole: square shade is (rank + file)
  parity, which a rotation preserves, and the learned per-square backgrounds are
  indexed by screen position, where the coordinates stay. So the coach says
  which side you are on and carries on rather than asking for a re-calibrate.
- **The board search needs the start position and a clear view.** It reads the
  empty middle ranks, so a board mid-game, partly covered, under a modal or
  smaller than 160px will not be found — and it looks at the shades, so a
  board whose two square colours are within ~10 grey levels of each other is
  rejected, as calibration would reject it anyway. It never *invents* a board:
  when it finds nothing it says so and the drag is still there.
- **The pre-move search now always asks for two lines.** A MultiPV 2 search can
  score a few centipawns differently from a single-line one at equal depth, since
  it prunes less. Grades are banded in win%, so this only matters exactly on a
  band boundary — and it applies whether or not you take a hint, so a grade never
  depends on whether you asked for help.
- **It starts at move 1 unless told otherwise.** `npm start` assumes the board
  is in the opening position. Start it mid-game and it is lost from the first
  frame — pass `--fen` with the current position instead.
- **A new game costs its first moves.** Starting a second game without
  restarting the coach is recognised — the screen matching the opening position
  on all 64 squares is proof no other rung can produce — and the coach starts
  over, the other way round if you got the other colour. What it cannot do is
  grade the moves played between the new game starting and it being noticed, so
  a game that begins while the board is covered or animating may be missing its
  first move or two. The finished game is kept as `game.pgn`, the next one as
  `game-2.pgn`.
- **Recovery is layered, not guaranteed.** Losing the board used to be fatal
  and is now seven rungs of getting it back (see below), but one rung reads
  the position off the screen and so cannot recover castling rights, en passant
  or the move number — and a move played while the board was out of sight is
  never graded. Moves found by recovery are logged `[you~]` / `[opp~]`.
