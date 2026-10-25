# factory-guild-submit

An agent skill that logs a contribution (X/Twitter post, GitHub project, video, event page) to your [Factory Guild](https://factory.ai/guild) submissions page. Give it a link. It reads the content, writes a title and description, fills the form, and submits it.

## Install

```sh
npx skills add nikships/factory-guild-submit
```

Add `-g` to install globally, or `-a droid` to target Factory Droid only.

## Requirements

- A logged-in Chromium browser with the `bsk` CLI and the `browser-skill` skill, which the agent uses to drive the Guild form.
- A Factory Guild account signed in to that browser.

## Usage

Ask your agent in plain language:

> Add https://x.com/someone/status/123 as a contribution in my factory.ai/guild submissions

Optionally include a title or description. Otherwise the skill derives both from the link.

Submissions land as `IN REVIEW`. The Guild Council awards points later.

## Layout

```
skills/factory-guild-submit/SKILL.md
```

## License

MIT
