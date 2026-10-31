// Door controls for the camera views: unlock or lock the front door, open/close
// the middle garage door. Only the actions listed in config.actions can run; the page
// names an action, never an HA service. Every use is written to HA's logbook.
import type { createHa } from "./ha.js";

type Ha = ReturnType<typeof createHa>;
export type ActionsConfig = {
  unlock: { entities: string[]; lock: string };            // buttons/locks to fire, and the lock whose state confirms it
  garage: { cover: string };                               // the garage door cover (open/close and its state)
};

export function createActions(ha: Ha, cfg: ActionsConfig) {
  const log = (message: string) =>
    ha.call("logbook", "log", { name: "Kitchen Frame", message, domain: "lock" }).catch(() => {});

  async function unlock() {
    await Promise.all(cfg.unlock.entities.map((e) => {
      const [domain] = e.split(".");
      if (domain === "button") return ha.call("button", "press", { entity_id: e });
      if (domain === "lock") return ha.call("lock", "unlock", { entity_id: e });
      throw new Error(`can't unlock with ${e}`);
    }));
    log("unlocked the front door from the kitchen frame");
  }

  // Locking only needs the deadbolt that reports the lock state.
  async function lock() {
    await ha.call("lock", "lock", { entity_id: cfg.unlock.lock });
    log("locked the front door from the kitchen frame");
  }

  // Open if closed, close if open. The cover's own actions pulse the relay and
  // refuse unsafe moves (open only after 5 s closed, close only after 20 s open).
  async function garage() {
    const { state } = await ha.state(cfg.garage.cover);
    const service = state === "closed" ? "open_cover" : "close_cover";
    await ha.call("cover", service, { entity_id: cfg.garage.cover });
    log(`${service === "open_cover" ? "opened" : "closed"} the middle garage door from the kitchen frame`);
  }

  // Current state for the buttons.
  async function states() {
    const [lock, garage] = await Promise.all([ha.state(cfg.unlock.lock), ha.state(cfg.garage.cover)]);
    return { lock: lock.state, garage: garage.state };
  }

  return {
    states,
    run: (action: string) =>
      action === "unlock" ? unlock() : action === "lock" ? lock() : action === "garage" ? garage()
      : Promise.reject(new Error(`unknown action ${action}`)),
  };
}
