# Duel UX rubric

What a good duel screen does, as rules. `npm run ux` checks the measurable ones automatically
(`scripts/ux/checks.js`, rule ids in brackets); the rest are for reading the report's screenshots.
Add a rule here whenever the user corrects something about how the duel should feel, and make it a check
when it can be measured.

## Pacing and impact
- Every moment gets its beat before the next one plays and before anyone is asked to decide: a summon 1.5 s,
  an activation 1.4 s, a new phase about 1 s, a new turn 1.5 s, a draw 0.65 s (+0.22 s per extra card).
  The numbers live in `src/shared/pacing.ts`. [decision-after-moment]
- Watching never costs clock time: the server's clock waits out the same beats (`ClockState.graceUntil`), and
  the clock shows as paused meanwhile.
- Space skips what is playing and goes straight to the decision.
- Each kind of moment looks and sounds distinct (summon kinds, activation kinds, draws, phases).
- Every summon (but a Set) and every activation gets its card-art splash, the same way every time: the card's
  fame changes the splash's label and size, never whether it plays. Chain link 2+ gets the short one.
- A splash holds the stage: through the middle of its run (30-70%) it is fully visible, never fading out early.
  (Put easing on each keyframe, not on the whole WAAPI effect: whole-effect easing moves the keyframes.)
  [scenes: splash timing]

## The decision
- What you can do right now shows on the card itself: a card you can Summon / Activate / Attack with glows in
  that action's colour and wears its tag; a pile with such a card (the Extra Deck) glows strongly enough to see
  at a glance: a ring 2 px or more, in a colour that stands out from the page behind the board. [stands-out]
  Clicking that pile offers the action (only the usable cards) or View all.
- Card pickers and pile views are docked, not modal: no dimmed or blurred board behind them, and every card in
  them shows its details (★ Level / Rank / Link, Tuner, Attribute and Type symbols, ATK / DEF).
- Chain prompts (Ask / Smart / Mine) switch with one click beside Next / End turn.
- When the duel asks you something, the panel and its buttons are fully on screen and nothing covers them.
  [decision-visible]
- The thing you're deciding about (the card, the targets) is highlighted and visible at the same time.
- The way forward (Next phase / End turn / don't chain) is always one press away and in the same place.

## Always on screen
- Both players' LP, whose turn it is, and the phase. [essentials]
- The turn sign names whoever the duel is waiting on: "Bot's turn" while the bot decides, even on your turn
  (not "Your turn · waiting for Bot"), and it stays readable when it isn't yours.
- Each player's clock sits right beside their LP, big and solid, lit while it runs; never faded with the stats.
- Your hand (it may peek from the bottom edge, but it is never scrolled away).

## Steady
- The hover preview always opens in the same place (the left side); it never jumps sides with the pointer, and
  it sits above everything else (pickers, pile views, dialogs, menus).

## Readable and clickable
- Text shows at 11 px or more on screen, after the scaled page's zoom. [text-size]
- Controls are at least 24 × 24 px on screen (44 px on phones), and don't sit on top of each other.
  [hit-target] [controls-overlap]
- No control is cut off by the window edge (the hand excepted). [offscreen-control]
- Labels aren't cut off without an ellipsis. [clipped-text]
- Accessible: text contrast, names on controls and images, valid roles (axe, no serious / critical issues; the
  scene tests run it on every fixed moment).

## Smooth
- No main-thread task long enough to drop frames during play (120 ms or more is flagged). [long-task]
  With a UX_SOURCEMAP build each finding names the source file:line; a long frame with almost no script or
  layout in it is [frame-delay] (the headless browser's missing GPU), low, not the page's code.
- No page errors. [page-error]

## Reading the report
- Rank by severity, then by how often a finding shows up. A finding seen at only one window size is usually a
  layout bug at that size; one seen at every size is a design problem.
- Look at the screenshots too: the checks can't judge clutter, hierarchy, whether the eye lands on the
  decision, or whether an animation reads well. Note those as findings by hand.
