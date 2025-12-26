const { EventEmitter } = require("events");
const mineflayer = require("mineflayer");

class MinecraftClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.bot = null;
    this.readyForCommands = false;
    this.queue = [];
    this.queueRunning = false;
    this.reconnectTimer = null;
  }

  isReady() {
    return this.readyForCommands && !!(this.bot && this.bot.player);
  }

  start() {
    if (this.bot) {
      return;
    }
    this.readyForCommands = false;
    const {
      host,
      port,
      username,
      auth = "microsoft",
      authTitle,
      version = "1.8.9",
      flow = "msal",
    } = this.config;
    this.bot = mineflayer.createBot({
      host,
      port,
      username,
      auth,
      authTitle,
      flow,
      version,
      viewDistance: "tiny",
      checkTimeoutInterval: 15_000,
    });
    this.attachListeners();
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = null;
    this.queue = [];
    this.queueRunning = false;
    this.readyForCommands = false;
    if (this.bot) {
      try {
        this.bot.quit("Stopped by controller");
      } catch (err) {
        // ignore
      }
    }
    this.bot = null;
  }

  attachListeners() {
    this.bot.once("spawn", () => {
      this.emit("online");
      this.prepareHousing();
    });

    this.bot.on("end", (reason) => {
      this.emit("offline", reason);
      this.scheduleReconnect();
    });

    this.bot.on("kicked", (reason, loggedIn) => {
      const text = this.parseKickReason(reason);
      this.emit("kicked", text, loggedIn);
      this.scheduleReconnect();
    });

    this.bot.on("error", (err) => {
      this.emit("error", err);
    });

    this.bot.on("messagestr", (message) => {
      this.emit("chat", message);
    });

    this.bot.on("playerJoined", (player) => {
      this.emit("player_join", player);
    });
    this.bot.on("playerLeft", (player) => {
      this.emit("player_leave", player);
    });
  }

  parseKickReason(reason) {
    if (typeof reason === "string") {
      return reason;
    }
    if (reason && typeof reason.text === "string") {
      return reason.text;
    }
    if (Array.isArray(reason?.extra)) {
      return reason.extra.map((e) => e.text).join("");
    }
    return JSON.stringify(reason);
  }

  prepareHousing() {
    const visitTarget = this.config.visitTarget;
    this.readyForCommands = false;
    // Queue the two commands with a slight delay buffer.
    this.sendCommand("/l housing");
    if (visitTarget) {
      this.sendCommand(`/visit ${visitTarget}`);
    }
    setTimeout(() => {
      this.readyForCommands = true;
      this.emit("ready");
    }, 4_000);
  }

  sendCommand(command) {
    if (!command) return;
    this.queue.push(command);
    this.processQueue();
  }

  processQueue() {
    if (this.queueRunning) return;
    if (!this.bot) return;
    this.queueRunning = true;
    const delay = Number(this.config.commandCooldownMs || 1200);
    const step = () => {
      const next = this.queue.shift();
      if (!next) {
        this.queueRunning = false;
        return;
      }
      try {
        this.bot.chat(next);
      } catch (err) {
        this.emit("error", err);
      }
      setTimeout(step, delay);
    };
    step();
  }

  ensureReady() {
    return this.readyForCommands && this.bot && this.bot.player;
  }

  sendChat(message) {
    if (!this.ensureReady()) {
      this.sendCommand(message);
      return;
    }
    this.sendCommand(message);
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.config.reconnectDelayMs === 0) {
      return;
    }
    const delay = Number(this.config.reconnectDelayMs || 5_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.bot = null;
      this.start();
    }, delay);
  }

  getPlayerCount() {
    if (!this.bot || !this.bot.players) return 0;
    const selfName = this.bot.username;
    return Object.values(this.bot.players || {}).filter(
      (p) => p && p.username && p.username !== selfName
    ).length;
  }
}

module.exports = { MinecraftClient };
