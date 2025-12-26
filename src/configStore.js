const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { ensureFile } = require("fs-extra");

class ConfigStore {
  constructor() {
    this.configPath = path.join(process.cwd(), "config.json");
    this.statePath = path.join(process.cwd(), "data", "mappings.json");
    this.config = null;
    this.bridge = { discordToMinecraft: [], housingToDiscord: [], livechatChannelId: null };
  }

  async load() {
    if (!fs.existsSync(this.configPath)) {
      throw new Error(
        `config.json fehlt. Kopiere config.example.json zu config.json und trage Token/Besitzer ein.`
      );
    }
    const configRaw = await fsp.readFile(this.configPath, "utf8");
    this.config = JSON.parse(configRaw);
    const bridgeDefaults =
      this.config.bridge || {
        discordToMinecraft: [],
        housingToDiscord: [],
        livechatChannelId: null,
      };
    await this.loadBridge(bridgeDefaults);
    return { ...this.config, bridge: this.bridge };
  }

  async loadBridge(defaults) {
    try {
      if (!fs.existsSync(this.statePath)) {
        await ensureFile(this.statePath);
        await fsp.writeFile(
          this.statePath,
          JSON.stringify(defaults, null, 2),
          "utf8"
        );
        this.bridge = defaults;
        return;
      }
      const raw = await fsp.readFile(this.statePath, "utf8");
      this.bridge = raw ? JSON.parse(raw) : defaults;
    } catch (err) {
      this.bridge = defaults;
      throw err;
    }
  }

  getConfig() {
    if (!this.config) {
      throw new Error("Config wurde noch nicht geladen.");
    }
    return { ...this.config, bridge: this.bridge };
  }

  async saveConfig(nextConfig) {
    this.config = nextConfig;
    await fsp.writeFile(
      this.configPath,
      JSON.stringify(this.config, null, 2),
      "utf8"
    );
  }

  async saveBridge(nextBridge) {
    this.bridge = nextBridge;
    await ensureFile(this.statePath);
    await fsp.writeFile(
      this.statePath,
      JSON.stringify(
        {
          discordToMinecraft: this.bridge.discordToMinecraft || [],
          housingToDiscord: this.bridge.housingToDiscord || [],
          livechatChannelId:
            this.bridge.livechatChannelId === undefined
              ? null
              : this.bridge.livechatChannelId,
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

module.exports = { ConfigStore };
