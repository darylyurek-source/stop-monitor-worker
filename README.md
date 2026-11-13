# stop-monitor-worker — the ONE copy of the DART engine

Since 2026-11-13, 1:55 PM ET, this repository is the only copy of the engine.
Base44 keeps no mirror of it. A change to a file here **is** the change: Render's
service `stop-monitor-worker` (branch `main`, autoDeploy on) builds
(`npm install`) and restarts (`node worker.js`) on that commit by itself,
roughly a minute later. Nothing is pushed anywhere a second time, and there is no
other tree to keep in step.

Why: until today Base44 carried a copy at `render-worker/` and this repository
carried another. Changes landed in one and not the other — on 2026-11-13 the
10:58 AM print gate and the second-print Hard Loss Stop were written in Base44
and never reached this repository, so the live engine ran the old rules all day.
That copy is gone. Editing engine code anywhere else recreates the problem.

## Rules for changing the engine

1. Read `DART_NOTES.md` in the Base44 app first — it is the record of every rule
   in force, and of when each one took effect.
2. Change the file here, in one commit, with a message that states the rule and
   the minute it takes effect.
3. Run every self-test before the commit when a rule moves:

   ```
   node tickDecisionSelfTest.js
   node priceGateSelfTest.js
   node protectiveTriggerSelfTest.js
   node feedStandbySelfTest.js
   node migrationSelfTest.js
   ```

4. Watch the deploy: Render → stop-monitor-worker → the commit becomes LIVE, and
   the service restarts on it. The deploy's commit and time are the proof of what
   is trading.

## Layout

All modules sit at the repository root; `worker.js` is the entry point.
`tickRules.js` holds every per-account level (hard stop, arm thresholds, Vector
exit), `tradeConditions.js` the price gate, `tickDecisionCore.js` the per-tick
decision, `engineShadow.js` the live loop and the hard-stop arming markers.
`replayDay.js`, `trailSweep.js`, `vectorSweep.js` and `closeSweep.js` are
read-only research tools: they run a recorded day through the same rule modules
and write nothing.
