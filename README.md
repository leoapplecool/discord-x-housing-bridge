# Discord <-> Hypixel Housing Bot

The bot logs into Hypixel with mineflayer (mc.hypixel.net, 1.8.9, Microsoft auth), runs `/l housing` then `/visit <target>`, and bridges Discord commands <-> Housing chat.

## Features
- Auto join: `/l housing` then `/visit <target>`
- Discord -> Minecraft text commands (admin-only)
- Housing chat -> Discord embeds (configurable triggers)
- Live chat stream with rolling code blocks (persisted channel)
- `/tab` embed listing online housing players
- Discord presence shows current player count

## Requirements
- Node.js 18+
- Discord bot with the following intents enabled in the Developer Portal:
  - Server Members Intent (required because the bot enables `GuildMembers`)
  - Message Content Intent (required for text command bridge)
- A Microsoft account for Minecraft login

## Quick start
1. `cp config.example.json config.json`
2. Fill `discordToken`, `discordClientId`, `guildId`, and `minecraft.username`.
3. Set `minecraft.visitTarget` to your housing owner name.
4. `npm install`
5. `npm start`
   - First login shows a device code + URL. Open the link and sign in. Tokens are cached by `prismarine-auth` (tied to `authTitle`).

## Configuration
Key settings in `config.json`:
- `discordToken`, `discordClientId`, `guildId`
- `adminRoleIds`: role IDs allowed to run admin-only commands
- `minecraft.*`: login details, visit target, reconnect delay
- `bridge.*`: mappings and triggers (auto-saved to `data/mappings.json`)

Env overrides:
- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GUILD_ID`
- `MC_EMAIL`, `MC_AUTH`, `MC_VISIT_TARGET`, `MC_FLOW`, `MC_AUTH_TITLE`

## Commands
The Slash command is `/configure` by default (changeable via `configureCommandName`) and is admin-only (admins or roles in `adminRoleIds`).

Subcommands:
- `list` – Show current mappings/triggers.
- `add-discord-command discord:"!whitelist {player}" minecraft:"/housing whitelist" with_player:true` – Map Discord → Minecraft; `{player}` is replaced with the provided player.
- `remove-discord-command discord:"!whitelist"` – Remove mapping.
- `add-housing-trigger match:"HOUSING STARTED" channel:#alerts title:"Housing Update" body:"{message}"` – If housing chat (lines without `:`) contains `match`, the bot sends an embed to the chosen channel (`{message}` is replaced).
- `remove-housing-trigger match:"HOUSING STARTED"`
- `set-visit-target target:"HousingOwner"` – Update the target for `/visit` and persist to `config.json`.

Other admin commands:
- `/chat message:"Text"` – Send text to Minecraft chat.
- `/livechat channel:#chatlog` – Stream all MC chat into code blocks in the given channel (up to ~20 lines per block; edited until full, then a new block). Ignores lobby/“you are currently in” lines; channel is persisted in `data/mappings.json`.
- `/tab` – Embed with currently detected housing players (tracked via join/leave chat lines).

## Runtime behavior
- Join: `/l housing` → `/visit <visitTarget>`, then commands are accepted.
- Discord → MC: Each Discord message starting with a configured command triggers the mapped MC command (with optional `{player}`).
- Housing → Discord: Chat lines without `:` are checked against triggers and sent as embeds. Full chat can also be streamed via `/livechat`.
- Persistence: `data/mappings.json` stores mappings/triggers and the livechat channel. `config.json` keeps secrets/base config.

## Notes
- `config.json` is ignored by git to avoid leaking secrets.
- Slash command registration uses guild scope when `guildId` is set (instant updates).
