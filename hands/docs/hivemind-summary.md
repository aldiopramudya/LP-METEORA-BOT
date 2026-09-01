# HiveMind Summary

## What It Is

HiveMind is Meridian's optional shared-intelligence layer.

Each Meridian agent can:

- register itself with a HiveMind server
- pull shared lessons from other agents
- pull shared presets/config ideas
- push its own lessons
- push closed-position performance events

If HiveMind is disabled, the rest of Meridian still works normally.

## Why It Exists

HiveMind gives one agent a way to learn from the experience of many agents without sharing private wallet secrets.

The goal is to help agents converge faster on:

- better lessons
- stronger pool selection patterns
- useful presets
- better awareness of what has been working across agents

## What Gets Shared

HiveMind is designed to share summaries, not secrets.

Examples of shared data:

- lessons and rules derived from performance
- closed-position outcomes
- pool address and optional pool name
- strategy used
- close reason
- PnL and fees
- hold duration
- pinned/manual lessons

Examples of data not intended to be shared:

- private keys
- raw wallet secrets
- full wallet balance snapshots
- local `.env` secrets

## How It Works In This Repo

The main implementation lives in [hivemind.js](../hivemind.js).

Core behavior:

- `bootstrapHiveMind()` registers the agent and pulls lessons/presets on startup
- `startHiveMindBackgroundSync()` refreshes registration and shared data every 15 minutes
- `pushHiveLesson()` sends lesson events
- `pushHivePerformanceEvent()` sends closed-position performance events
- pulled lessons and presets are cached in `hivemind-cache.json`

## Required Config

HiveMind only activates when both of these are configured:

- `hiveMindUrl`
- `hiveMindApiKey`

An `agentId` is generated automatically and persisted into `user-config.json` if missing.

## Prompt Impact

Shared lessons are injected into agent prompts through `getSharedLessonsForPrompt()`.

That means HiveMind can directly influence future screening and management decisions by adding cross-agent lessons into prompt context.

## Operational Notes

- HiveMind sync is non-blocking by design
- failed requests only log warnings
- background sync runs every 15 minutes
- local cache is still used even if the remote service is temporarily unavailable
