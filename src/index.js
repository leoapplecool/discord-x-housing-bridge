/* eslint-disable no-console */
require("dotenv").config();
const {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");
const { ConfigStore } = require("./configStore");
const { MinecraftClient } = require("./minecraftClient");

const store = new ConfigStore();

function mergeConfig(baseConfig) {
  const minecraft = { ...(baseConfig.minecraft || {}) };
  const env = process.env;
  if (env.MC_EMAIL) minecraft.username = env.MC_EMAIL;
  if (env.MC_AUTH) minecraft.auth = env.MC_AUTH;
  if (env.MC_AUTH_TITLE) minecraft.authTitle = env.MC_AUTH_TITLE;
  if (env.MC_VISIT_TARGET) minecraft.visitTarget = env.MC_VISIT_TARGET;
  if (env.MC_FLOW) minecraft.flow = env.MC_FLOW;
  minecraft.host = minecraft.host || "mc.hypixel.net";
  minecraft.port = minecraft.port || 25565;
  minecraft.version = minecraft.version || "1.8.9";
  minecraft.auth = minecraft.auth || "microsoft";
  minecraft.flow = (minecraft.flow || "live").toLowerCase();
  const defaultMsalClientId = "389b1b32-b5d5-43b2-bddc-84ce938d6737";
  const defaultLiveTitle = "00000000402b5328"; // Minecraft Java title ID
  const looksLikeGuid = (val) => typeof val === "string" && /^[0-9a-fA-F-]{36}$/.test(val);
  if (minecraft.flow === "msal") {
    if (!looksLikeGuid(minecraft.authTitle)) {
      minecraft.authTitle = defaultMsalClientId; // default MSAL client id from prismarine-auth
    }
  } else {
    minecraft.flow = "live";
    if (!minecraft.authTitle || minecraft.authTitle === "") {
      minecraft.authTitle = defaultLiveTitle;
    }
  }
  minecraft.commandCooldownMs = minecraft.commandCooldownMs || 1200;
  if (minecraft.reconnectDelayMs === undefined) {
    minecraft.reconnectDelayMs = 5_000;
  }
  return {
    ...baseConfig,
    discordToken: env.DISCORD_TOKEN || baseConfig.discordToken,
    discordClientId: env.DISCORD_CLIENT_ID || baseConfig.discordClientId,
    guildId: env.GUILD_ID || baseConfig.guildId,
    configureCommandName: baseConfig.configureCommandName || "configure",
    minecraft,
  };
}

function buildConfigureCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription("Configure the Discord ↔ Housing bridge")
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("Show current mappings and triggers")
    )
    .addSubcommand((sub) =>
      sub
        .setName("add-discord-command")
        .setDescription(
          "Map a Discord command (e.g. !sayhello) to a Minecraft command"
        )
        .addStringOption((opt) =>
          opt
            .setName("discord")
            .setDescription('Discord command, e.g. "!invite {player}"')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("minecraft")
            .setDescription('Minecraft command (without player), e.g. "/invite"')
            .setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("with_player")
            .setDescription("If true, {player} is appended to the MC command")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove-discord-command")
        .setDescription("Remove a Discord → Minecraft mapping")
        .addStringOption((opt) =>
          opt
            .setName("discord")
            .setDescription('Discord command, e.g. "!sayhello"')
            .setAutocomplete(true)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("add-housing-trigger")
        .setDescription(
          "Send a Discord embed when housing chat contains this text (no ':' lines)"
        )
        .addStringOption((opt) =>
          opt
            .setName("match")
            .setDescription('Text to match in housing, e.g. "HOUSING STARTED"')
            .setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel that receives the embed")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("title")
            .setDescription("Optional embed title (default: Housing Update)")
        )
        .addStringOption((opt) =>
          opt
            .setName("body")
            .setDescription(
              "Optional embed body; {message} is replaced with the MC message"
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove-housing-trigger")
        .setDescription("Remove a Housing → Discord trigger")
        .addStringOption((opt) =>
          opt
            .setName("match")
            .setDescription("Match text")
            .setAutocomplete(true)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-visit-target")
        .setDescription("Set the /visit target (after /l housing)")
        .addStringOption((opt) =>
          opt
            .setName("target")
            .setDescription("Housing owner/name for /visit")
            .setRequired(true)
        )
    )
    .toJSON();
}

function buildChatCommand() {
  return new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Send a message to Minecraft chat (Admin)")
    .addStringOption((opt) =>
      opt
        .setName("message")
        .setDescription("Message to send via the bot into MC chat")
        .setRequired(true)
    )
    .toJSON();
}

function buildLivechatCommand() {
  return new SlashCommandBuilder()
    .setName("livechat")
    .setDescription("Forward all MC chat messages into a Discord channel (Admin)")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel that will receive the live chat stream")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .toJSON();
}

function buildTabCommand() {
  return new SlashCommandBuilder()
    .setName("tab")
    .setDescription("Show current players in housing (Admin)")
    .toJSON();
}

function isAdmin(member, adminRoleIds = []) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  if (adminRoleIds.length && member.roles) {
    return member.roles.cache.some((role) => adminRoleIds.includes(role.id));
  }
  return false;
}

function cleanDiscordCommand(cmd) {
  return cmd.replace(/\s+/g, " ").trim();
}

function mappingFromInput(discordCommand, minecraftCommand, withPlayerFlag) {
  const normalized = cleanDiscordCommand(discordCommand);
  const expectsPlayer =
    withPlayerFlag || normalized.toLowerCase().includes("{player}");
  const base = normalized.replace("{player}", "").trim();
  const storedDiscord = expectsPlayer ? `${base} {player}` : base;
  return {
    discordCommand: storedDiscord,
    minecraftCommand: minecraftCommand.trim(),
    withPlayer: expectsPlayer,
  };
}

function parseMapping(mapping) {
  const expectsPlayer =
    mapping.withPlayer || mapping.discordCommand?.includes("{player}");
  const base = mapping.discordCommand
    ? mapping.discordCommand.replace("{player}", "").trim()
    : "";
  return { base, expectsPlayer, minecraftCommand: mapping.minecraftCommand };
}

function formatList(bridge) {
  const discordToMcList =
    bridge.discordToMinecraft?.length === 0
      ? ["(none)"]
      : bridge.discordToMinecraft.map((m) => {
          const display =
            m.discordCommand?.includes("{player}") || !m.withPlayer
              ? m.discordCommand
              : `${m.discordCommand} {player}`;
          return `${display}  →  ${m.minecraftCommand}`;
        });

  const housingToDiscordList =
    bridge.housingToDiscord?.length === 0
      ? ["(none)"]
      : bridge.housingToDiscord.map(
          (m) =>
            `"${m.match}"  →  #${m.channelId}  (${m.embed?.title || "Embed"})`
        );

  return { discordToMcList, housingToDiscordList };
}

async function main() {
  const loadedConfig = await store.load();
  const config = mergeConfig(loadedConfig);
  if (!config.discordToken) {
    throw new Error("Discord token missing (DISCORD_TOKEN or config.json).");
  }
  if (!config.minecraft?.username) {
    console.warn(
      "Warning: No Minecraft user set (MC_EMAIL or config.minecraft.username)."
    );
  }
  let bridge = loadedConfig.bridge;

  const discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel],
  });

  const mcClient = new MinecraftClient(config.minecraft);
  const presenceState = { interval: null };
  const onlinePlayers = new Set();

  const syncOnlineFromBot = () => {
    if (!mcClient.bot || !mcClient.bot.players) return;
    onlinePlayers.clear();
    Object.values(mcClient.bot.players).forEach((p) => {
      if (p?.username && p.username !== mcClient.bot.username) {
        onlinePlayers.add(p.username);
      }
    });
  };

  const updatePresence = () => {
    if (!discordClient.user) return;
    const online = mcClient.isReady();
    const count =
      onlinePlayers.size > 0 ? onlinePlayers.size : mcClient.getPlayerCount();
    const activity = online
      ? { name: `${count} players in housing`, type: 3 }
      : { name: "connecting...", type: 3 };
    discordClient.user.setPresence({
      activities: [activity],
      status: online ? "online" : "idle",
    });
  };

  discordClient.once("ready", async () => {
    console.log(`Discord logged in as ${discordClient.user?.tag || "unknown"}`);
    try {
      const commandData = [
        buildConfigureCommand(config.configureCommandName),
        buildChatCommand(),
        buildLivechatCommand(),
        buildTabCommand(),
      ];
      if (config.guildId) {
        await discordClient.application.commands.set(
          commandData,
          config.guildId
        );
        console.log(
          `Slash commands updated in guild scope (${config.guildId}).`
        );
      } else {
        await discordClient.application.commands.set(commandData);
        console.log(
          "Slash commands registered globally (can take a few minutes)."
        );
      }
    } catch (err) {
      console.error("Slash command registration failed:", err);
    }
    updatePresence();
    await ensureLiveChatChannel();
  });

  mcClient.on("online", () => {
    console.log("Minecraft bot online, joining housing...");
    syncOnlineFromBot();
    updatePresence();
  });
  mcClient.on("ready", () => {
    console.log("Minecraft bot is ready and in housing.");
    syncOnlineFromBot();
    updatePresence();
  });
  mcClient.on("offline", (reason) => {
    console.warn("Minecraft bot offline:", reason);
    onlinePlayers.clear();
    updatePresence();
  });
  mcClient.on("kicked", (reason, loggedIn) => {
    console.warn("Minecraft bot kicked:", reason, { loggedIn });
    onlinePlayers.clear();
    updatePresence();
  });
  mcClient.on("error", (err) => {
    console.error("Minecraft error:", err?.message || err);
  });
  discordClient.on("error", (err) => {
    console.error("Discord error:", err?.message || err);
  });

  mcClient.on("player_join", (player) => {
    if (player?.username) onlinePlayers.add(player.username);
    updatePresence();
  });
  mcClient.on("player_leave", (player) => {
    if (player?.username) onlinePlayers.delete(player.username);
    updatePresence();
  });

  const respond = async (interaction, payload, ephemeral = false) => {
    const data = ephemeral
      ? { ...payload, flags: MessageFlags.Ephemeral }
      : payload;
    try {
      if (interaction.replied || interaction.deferred) {
        return await interaction.followUp(data);
      }
      return await interaction.reply(data);
    } catch (err) {
      const code = err?.code || err?.rawError?.code;
      if (code === 10062 || code === 40060) {
        return null;
      }
      console.error("Discord reply error:", err?.message || err);
      return null;
    }
  };

  const liveChatState = {
    channelId: bridge.livechatChannelId || null,
    channel: null,
    lines: [],
    message: null,
    queue: Promise.resolve(),
  };

  async function pushLiveChat(line) {
    if (!liveChatState.channelId) return;
    liveChatState.queue = liveChatState.queue
      .then(async () => {
        const channel =
          liveChatState.channel ||
          (await discordClient.channels
            .fetch(liveChatState.channelId)
            .catch(() => null));
        if (!channel || channel.type !== ChannelType.GuildText) {
          liveChatState.channelId = null;
          liveChatState.channel = null;
          liveChatState.lines = [];
          liveChatState.message = null;
          return;
        }
        liveChatState.channel = channel;

        const maxLines = 20;
        if (!liveChatState.message || liveChatState.lines.length >= maxLines) {
          liveChatState.lines = [line];
          liveChatState.message = await channel.send({
            content: `\`\`\`\n${liveChatState.lines.join("\n")}\n\`\`\``,
          });
          return;
        }

        liveChatState.lines.push(line);
        const content = `\`\`\`\n${liveChatState.lines.join("\n")}\n\`\`\``;
        try {
          await liveChatState.message.edit({ content });
        } catch (err) {
          console.warn("Livechat edit failed, starting new block:", err);
          liveChatState.lines = [line];
          liveChatState.message = await channel.send({
            content: `\`\`\`\n${liveChatState.lines.join("\n")}\n\`\`\``,
          });
        }
      })
      .catch((err) => {
        console.error("Livechat error:", err?.message || err);
      });
  }

  async function ensureLiveChatChannel() {
    if (!liveChatState.channelId) return;
    try {
      const channel =
        discordClient.channels.cache.get(liveChatState.channelId) ||
        (await discordClient.channels
          .fetch(liveChatState.channelId)
          .catch(() => null));
      if (channel && channel.type === ChannelType.GuildText) {
        liveChatState.channel = channel;
      } else {
        liveChatState.channelId = null;
        liveChatState.channel = null;
      }
    } catch (err) {
      console.error("Failed to load livechat channel:", err?.message || err);
    }
  }

  const joinLeaveRegex = /^(?:\[[^\]]+]\s+)?([A-Za-z0-9_]{1,16})\s+(entered|left) the world\.$/i;
  const liveChatIgnore = [
    "to leave, type /lobby or right click the door/ghast tear in your hotbar!",
    "you are currently in",
  ];
  const recentChat = new Map();
  const dedupeWindowMs = 2000;
  const shouldEmitChat = (line) => {
    if (!line) return false;
    const lower = line.toLowerCase();
    if (liveChatIgnore.some((text) => lower.includes(text))) return false;
    const now = Date.now();
    const last = recentChat.get(line);
    if (last && now - last < dedupeWindowMs) {
      return false;
    }
    recentChat.set(line, now);
    // prune occasionally
    if (recentChat.size > 200) {
      for (const [msg, ts] of recentChat) {
        if (now - ts > dedupeWindowMs * 2) {
          recentChat.delete(msg);
        }
      }
    }
    return true;
  };

  // Discord -> Minecraft
  discordClient.on("messageCreate", async (message) => {
    if (message.author.bot || message.webhookId) return;
    if (!message.guild) return;
    if (!isAdmin(message.member, config.adminRoleIds || [])) return;

    for (const mapping of bridge.discordToMinecraft || []) {
      const { base, expectsPlayer, minecraftCommand } = parseMapping(mapping);
      if (!base) continue;
      const content = message.content.trim();
      if (!content.toLowerCase().startsWith(base.toLowerCase())) continue;

      let finalCommand = minecraftCommand;
      if (expectsPlayer) {
        const [, playerName] = content.split(/\s+/, 2);
        if (!playerName) {
          await message.reply(`Please supply a player: \`${base} {player}\``);
          return;
        }
        finalCommand = `${minecraftCommand} ${playerName}`;
      } else if (content.toLowerCase() !== base.toLowerCase()) {
        continue;
      }
      mcClient.sendChat(finalCommand);
      try {
        await message.react("✅");
      } catch (err) {
        // ignore reaction errors
      }
      break;
    }
  });

  // Housing -> Discord
  mcClient.on("chat", async (mcMessage) => {
    // Track join/leave lines
    const match = mcMessage && joinLeaveRegex.exec(mcMessage.trim());
    if (match) {
      const playerName = match[1];
      const action = match[2].toLowerCase();
      if (action === "entered") {
        onlinePlayers.add(playerName);
      } else if (action === "left") {
        onlinePlayers.delete(playerName);
      }
      updatePresence();
    }

    if (!shouldEmitChat(mcMessage)) return;

    // Livechat stream: send all messages (including lines with ':')
    pushLiveChat(mcMessage);

    if (!mcMessage || mcMessage.includes(":")) return;
    const lower = mcMessage.toLowerCase();
    for (const trigger of bridge.housingToDiscord || []) {
      if (!trigger.match) continue;
      if (!lower.includes(trigger.match.toLowerCase())) continue;
      const channel =
        discordClient.channels.cache.get(trigger.channelId) ||
        (await discordClient.channels.fetch(trigger.channelId).catch(() => null));
      if (!channel || channel.type !== ChannelType.GuildText) continue;
      const embed = new EmbedBuilder()
        .setTitle(trigger.embed?.title || "Housing Update")
        .setDescription(
          (trigger.embed?.description || "{message}").replace(
            "{message}",
            mcMessage
          )
        )
        .setColor(trigger.embed?.color || 0x00a8ff)
        .setTimestamp(new Date());
      channel.send({ embeds: [embed] }).catch((err) => {
        console.error("Failed to send embed:", err?.message || err);
      });
    }
  });

  // /configure handler
  discordClient.on("interactionCreate", async (interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== config.configureCommandName) return;
      const sub = interaction.options.getSubcommand();
      if (sub === "remove-discord-command") {
        const choices =
          (bridge.discordToMinecraft || []).slice(0, 25).map((m) => ({
            name: m.discordCommand,
            value: m.discordCommand,
          })) || [];
        await interaction.respond(choices);
      } else if (sub === "remove-housing-trigger") {
        const choices =
          (bridge.housingToDiscord || []).slice(0, 25).map((m) => ({
            name: m.match,
            value: m.match,
          })) || [];
        await interaction.respond(choices);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (
      interaction.commandName === config.configureCommandName ||
      interaction.commandName === "chat" ||
      interaction.commandName === "livechat" ||
      interaction.commandName === "tab"
    ) {
      if (!isAdmin(interaction.member, config.adminRoleIds || [])) {
        await respond(
          interaction,
          {
            content: "Only administrators can use this command.",
          },
          true
        );
        return;
      }
    } else {
      return;
    }

    if (interaction.commandName === "chat") {
      const msg = interaction.options.getString("message", true).trim();
      mcClient.sendChat(msg);
      await respond(
        interaction,
        { content: `Sent message: "${msg}"` },
        true
      );
      return;
    }

    if (interaction.commandName === "livechat") {
      const channel = interaction.options.getChannel("channel", true);
      if (channel.type !== ChannelType.GuildText) {
        await respond(
          interaction,
          { content: "Please choose a text channel." },
          true
        );
        return;
      }
      liveChatState.channelId = channel.id;
      liveChatState.channel = channel;
      liveChatState.lines = [];
      liveChatState.message = null;
      const next = { ...bridge, livechatChannelId: channel.id };
      await store.saveBridge(next);
      bridge = next;
      await respond(
        interaction,
        { content: `Livechat enabled in #${channel.name}.` },
        true
      );
      return;
    }

    if (interaction.commandName === "tab") {
      const names = Array.from(onlinePlayers).sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase())
      );
      const embed = new EmbedBuilder()
        .setTitle("Housing Online")
        .setDescription(
          names.length > 0 ? names.map((n) => `• ${n}`).join("\n") : "Nobody online"
        )
        .setColor(0x00a8ff)
        .setTimestamp(new Date());
      await respond(interaction, { embeds: [embed] }, true);
      return;
    }

    // /configure handler
    if (interaction.commandName !== config.configureCommandName) return;
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === "list") {
        const { discordToMcList, housingToDiscordList } = formatList(bridge);
        const embed = new EmbedBuilder()
          .setTitle("Bridge configuration")
          .setColor(0x00a8ff)
          .addFields(
            {
              name: "Discord → Minecraft",
              value: discordToMcList.join("\n"),
            },
            {
              name: "Housing → Discord",
              value: housingToDiscordList.join("\n"),
            }
          )
          .setTimestamp(new Date());
        await respond(interaction, { embeds: [embed] }, true);
      } else if (sub === "add-discord-command") {
        const discordCmd = interaction.options.getString("discord", true);
        const mcCmd = interaction.options.getString("minecraft", true);
        const withPlayer = interaction.options.getBoolean("with_player") || false;
        const newMapping = mappingFromInput(discordCmd, mcCmd, withPlayer);
        const filtered =
          bridge.discordToMinecraft?.filter(
            (m) =>
              m.discordCommand.toLowerCase() !==
              newMapping.discordCommand.toLowerCase()
          ) || [];
        const next = { ...bridge, discordToMinecraft: [...filtered, newMapping] };
        await store.saveBridge(next);
        bridge = next;
        await respond(
          interaction,
          {
            content: `Saved: ${newMapping.discordCommand} -> ${newMapping.minecraftCommand}`,
          },
          true
        );
      } else if (sub === "remove-discord-command") {
        const discordCmd = cleanDiscordCommand(
          interaction.options.getString("discord", true)
        );
        const filtered =
          bridge.discordToMinecraft?.filter(
            (m) =>
              m.discordCommand.replace("{player}", "").trim().toLowerCase() !==
              discordCmd.replace("{player}", "").trim().toLowerCase()
          ) || [];
        const next = { ...bridge, discordToMinecraft: filtered };
        await store.saveBridge(next);
        bridge = next;
        await respond(
          interaction,
          { content: `Mapping for ${discordCmd} removed.` },
          true
        );
      } else if (sub === "add-housing-trigger") {
        const match = interaction.options.getString("match", true);
        const channel = interaction.options.getChannel("channel", true);
        const title = interaction.options.getString("title") || "Housing Update";
        const body = interaction.options.getString("body") || "{message}";
        if (channel.type !== ChannelType.GuildText) {
          await respond(
            interaction,
            { content: "Please provide a text channel for the embed." },
            true
          );
          return;
        }

        const newTrigger = {
          match,
          channelId: channel.id,
          embed: { title, description: body, color: 0x00a8ff },
        };

        const filtered =
          bridge.housingToDiscord?.filter(
            (t) => t.match.toLowerCase() !== match.toLowerCase()
          ) || [];
        const next = { ...bridge, housingToDiscord: [...filtered, newTrigger] };
        await store.saveBridge(next);
        bridge = next;
        await respond(
          interaction,
          { content: `Trigger "${match}" -> #${channel.name} saved.` },
          true
        );
      } else if (sub === "remove-housing-trigger") {
        const match = interaction.options.getString("match", true);
        const filtered =
          bridge.housingToDiscord?.filter(
            (t) => t.match.toLowerCase() !== match.toLowerCase()
          ) || [];
        const next = { ...bridge, housingToDiscord: filtered };
        await store.saveBridge(next);
        bridge = next;
        await respond(
          interaction,
          { content: `Trigger "${match}" removed.` },
          true
        );
      } else if (sub === "set-visit-target") {
        const target = interaction.options.getString("target", true).trim();
        const currentFileConfig = store.config || loadedConfig;
        const nextFileConfig = {
          ...currentFileConfig,
          minecraft: { ...(currentFileConfig.minecraft || {}), visitTarget: target },
        };
        await store.saveConfig(nextFileConfig);
        config.minecraft.visitTarget = target;
        mcClient.config.visitTarget = target;
        mcClient.sendCommand(`/visit ${target}`);
        await respond(
          interaction,
          { content: `Visit target set to "${target}" (sent now).` },
          true
        );
      }
    } catch (err) {
      console.error("Error in /configure:", err);
      await respond(
        interaction,
        { content: `Error: ${err.message || err}` },
        true
      );
    }
  });

  process.on("SIGINT", () => {
    console.log("Stopping bot...");
    if (presenceState.interval) clearInterval(presenceState.interval);
    mcClient.stop();
    discordClient.destroy();
    process.exit(0);
  });

  mcClient.start();
  presenceState.interval = setInterval(updatePresence, 30_000);
  await discordClient.login(config.discordToken);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
