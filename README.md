# factory-guild-submit

An agent skill and standalone CLI that logs a contribution (X/Twitter post, GitHub project, video, blog post, event page) to your [Factory Guild](https://factory.ai/guild) submissions page. Give it a link. It writes the title and description, checks the suggested contribution type, and submits.

It calls the same JSON API as the Guild web form, so there is no browser dependency. You provide your session token once.

## Install the skill

```sh
npx skills add nikships/factory-guild-submit
```

Add `-g` to install globally, or `-a droid` to target Factory Droid only. Requires Node 18+.

## One-time auth

The CLI needs your Guild session token, the `__Secure-guild_session` cookie. It is `HttpOnly`, so copy it from devtools:

1. Sign in at https://factory.com/guild/submissions.
2. Open devtools > Application > Cookies > `https://factory.com`.
3. Copy the value of `__Secure-guild_session`.
4. Run `guild auth set` and paste it (or ask your agent to run it).

The CLI checks the token with the server before saving it to `~/.config/factory-guild/auth.json` (mode 0600). Sessions last about two weeks, so repeat when it expires. `FACTORY_GUILD_SESSION` overrides the saved token.

## Use it with your agent

> Add https://x.com/someone/status/123 as a contribution in my factory.ai/guild submissions

The agent reads the link, drafts a title and description, runs a dry run, then submits.

## Use the CLI directly

```sh
alias guild="node ~/.agents/skills/factory-guild-submit/scripts/guild.mjs"   # path depends on where the skill was installed
# or run it without installing the skill:
npx -y github:nikships/factory-guild-submit auth set

guild auth set
guild auth status
guild submit https://github.com/me/project -t "My project" -d "What it does, and how Droid helped" --dry-run
guild submit https://github.com/me/project -t "My project" -d "What it does, and how Droid helped"
guild submit a.com/1 b.com/2 -t "Series" --type blog     # up to 5 links in one contribution
guild submit -t "Private tool" -d "Why it matters" --type project_private -f demo.mp4
guild withdraw <id>
guild withdraw --group <group-id>
```

Types: `text_post`, `blog`, `video`, `project_public`, `project_private`. Without `--type`, the CLI uses the server's suggestion, or leaves the choice to the Guild Council. Files can be JPEG, PNG, HEIC, WebP, GIF, PDF, MP4, MOV, or WebM, up to 50 MB.

Submissions land as `IN REVIEW`. The Guild Council awards points later.

## Layout

```
skills/factory-guild-submit/SKILL.md
skills/factory-guild-submit/scripts/guild.mjs
```

## Caveat

This uses Guild endpoints that are not a public, documented API. They may change without notice.

## License

MIT
