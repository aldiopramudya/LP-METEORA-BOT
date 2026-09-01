# HiveMind Reference

## Files

- `hivemind.js`
- `hivemind-cache.json`
- `user-config.json`

## Enablement

HiveMind is enabled when:

- `config.hiveMind.url` is set
- `config.hiveMind.apiKey` is set

Checked via:

- `isHiveMindEnabled()`

## Local State

### `user-config.json`

Stores:

- `hiveMindUrl`
- `hiveMindApiKey`
- `agentId`

### `hivemind-cache.json`

Stores:

- `sharedLessons`
- `presets`
- `pulledAt`

## Main Flows

### Startup

`bootstrapHiveMind()`

- ensures agent id exists
- registers the agent
- pulls lessons
- pulls presets

### Background Sync

`startHiveMindBackgroundSync()`

- repeats every 15 minutes
- re-registers agent heartbeat
- refreshes lessons and presets

### Lesson Push

`pushHiveLesson(lesson)`

Builds a lesson event with:

- lesson id
- rule
- tags
- role
- outcome
- source type
- confidence
- optional pool reference
- pinned state
- optional metrics

### Performance Push

`pushHivePerformanceEvent(perf)`

Sends:

- pool
- poolName
- baseMint
- strategy
- closeReason
- pnlUsd
- pnlPct
- feesUsd
- feesSol
- minutesHeld
- adjusted-win-rate inclusion flag

## Remote Endpoints Used

### Register Agent

- `POST /api/hivemind/agents/register`

### Pull Lessons

- `GET /api/hivemind/lessons/pull`

### Pull Presets

- `GET /api/hivemind/presets/pull`

### Push Lesson

- `POST /api/hivemind/lessons/push`

### Push Performance

- `POST /api/hivemind/performance/push`

## Safety / Sanitization

Before sending data, the module sanitizes text by:

- flattening whitespace
- removing `<`, `>`, and backticks
- trimming and length-limiting fields

This reduces prompt injection noise and keeps payloads compact.

## Important Behavior Detail

Out-of-range closes are excluded from adjusted win-rate calculations by `shouldCountInAdjustedWinRate()`.

That means HiveMind treats some OOR outcomes as structurally different from normal strategy wins/losses.
